// DeepSeek's Fetch as web_read's second reader (2026-10-17): asked only after our own read has run — robots.txt, every
// hop pinned to a public address, the size caps — and ended unreadable for a reason a fetcher elsewhere can overcome;
// its result says it is DeepSeek's rendition. The DeepSeek answers replayed here were recorded from the live API that
// day (fixtures/deepseek-tools).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";

import { createDeepSeekTools, deepseekRenditionResult, unescapedRendition, webReadFallbackReason } from "../src/deepseekTools.mjs";
import { createPublicSourceGatewayHandler } from "../src/publicSourceGateway.mjs";
import { createWebReader } from "../src/webRead.mjs";
import { nodeWebTransport, webReadError } from "../src/webReadNetwork.mjs";

const recorded = JSON.parse(await readFile(new URL("./fixtures/deepseek-tools/recorded-2026-10-17.json", import.meta.url), "utf8")).answers;
const challenge = await readFile(new URL("./fixtures/web-read/nmpa-ggtg.412.html", import.meta.url));
const KEY = "sk-test-deepseek-key-not-real";
const readConfig = { webReadEnabled: true, webReadHostIntervalMs: 0, webReadConcurrency: 4, publicSourceGatewayMaxResponseBytes: 64 * 1024, publicUrl: "https://evimed.example.cn" };
const withKey = { ...readConfig, deepseekApiKey: KEY, deepseekBaseUrl: "https://api.deepseek.com" };

const html = (text, status = 200, extra = {}) => ({ status, headers: { "content-type": "text/html; charset=utf-8", ...extra }, body: Buffer.isBuffer(text) ? text : Buffer.from(text) });
const noRobots = () => ({ status: 404, headers: {}, body: Buffer.alloc(0) });

function fakeTransport(table) {
  const requests = [];
  const transport = async ({ url, signal }) => {
    requests.push(url.href);
    const entry = table[url.href] ?? (url.pathname === "/robots.txt" ? noRobots : null);
    if (!entry) throw new Error(`unexpected request ${url.href}`);
    return typeof entry === "function" ? entry(url, signal) : entry;
  };
  return { transport, requests };
}

function answer(payload, status = 200) {
  const body = JSON.stringify(payload);
  return { ok: status >= 200 && status < 300, status, headers: new Headers({ "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) }), text: async () => body, body: { cancel: async () => {} } };
}

/** DeepSeek's Fetch, answering `reply` and recording each request it was sent. */
function deepseekFetch(reply = answer(recorded["fetch-docs"].body)) {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init.body), authorization: init.headers.authorization });
    return typeof reply === "function" ? reply() : reply;
  };
  return { sent, fetchImpl };
}

function fakeLedger() {
  const calls = [];
  return {
    calls,
    async reserveModel(input) { calls.push(["reserve", input]); return { id: input.id }; },
    async settleModel(userId, id, input) { calls.push(["settle", { userId, id, ...input }]); },
    async markUncertain(userId, id, code, options) { calls.push(["uncertain", { userId, id, code, ...options }]); },
    async release(userId, id, code) { calls.push(["release", { userId, id, code }]); },
  };
}

const identity = { userId: "alice", projectId: "paper-1", runId: null, dailyLimit: 0, weeklyLimit: 0 };
const runtimeManager = { assertActiveModelGatewayToken: (token) => { if (token !== "runtime-token") throw new Error("invalid token"); return identity; } };

async function gateway(t, config, { transport, resolveImpl, deepseek, usageLedger = null }) {
  const webReader = createWebReader(config, { transport, ...(resolveImpl ? { resolveImpl } : {}) });
  const deepseekTools = createDeepSeekTools(config, { fetchImpl: deepseek.fetchImpl, usageLedger, attributeRun: async () => "run-3" });
  const server = createServer(createPublicSourceGatewayHandler(config, runtimeManager, { webReader, deepseekTools }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (url) => {
    const response = await fetch(`${base}/internal/sources/v1/fetch`, {
      method: "POST", headers: { authorization: "Bearer runtime-token", "content-type": "application/json" }, body: JSON.stringify({ webRead: { url } }),
    });
    return { status: response.status, body: await response.json() };
  };
}

test("a challenge our read cannot open is read once through DeepSeek's Fetch, labelled as its rendition and booked", async (t) => {
  const page = "https://www.nmpa.gov.cn/xxgk/ggtg/index.html";
  const deepseek = deepseekFetch();
  const ledger = fakeLedger();
  const read = await gateway(t, withKey, { transport: fakeTransport({ [page]: html(challenge, 412) }).transport, deepseek, usageLedger: ledger });
  const { status, body } = await read(page);
  assert.equal(status, 200);
  assert.deepEqual(deepseek.sent.map((entry) => [entry.url, entry.body]), [["https://api.deepseek.com/v1/tools/fetch", { url: page }]]);
  assert.equal(deepseek.sent[0].authorization, `Bearer ${KEY}`);
  const content = recorded["fetch-docs"].body.content;
  assert.equal(body.receipt.via, "deepseek-fetch");
  assert.equal(body.receipt.fallbackReason, "needs_browser");
  assert.equal(body.receipt.url, page);
  assert.equal(body.receipt.contentType, "text");
  assert.equal(body.receipt.mediaType, "text/markdown");
  assert.equal(body.receipt.official, true, "the page's own address decides the label, whoever read it");
  assert.equal(body.receipt.rendered, false);
  assert.equal(body.receipt.title, "Your First API Call | DeepSeek API Docs");
  assert.equal(body.receipt.sha256, createHash("sha256").update(content, "utf8").digest("hex"), "the digest is of the rendition exactly as received");
  assert.equal(body.receipt.bytes, Buffer.byteLength(content, "utf8"));
  assert.deepEqual(body.receipt.extractor, { name: "deepseek-fetch", version: "1" });
  assert.match(body.text, /^Search \/ Fetch API is now available, powered by our in-house search engine/, "DeepSeek's backslash escapes are undone");
  assert.match(body.text, /It is now served by DeepSeek-V4\.1-Flash-1017, and the calling method remains unchanged\./);
  assert.ok(!/\\[.,:()-]/.test(body.text.slice(0, 600)));
  assert.deepEqual(body.links, []);
  assert.ok(!JSON.stringify(body).includes(KEY));
  assert.deepEqual(ledger.calls.map(([kind]) => kind), ["reserve", "settle"]);
  assert.equal(ledger.calls[0][1].model, "deepseek-fetch");
  assert.equal(ledger.calls[0][1].purpose, "web-search");
  assert.equal(ledger.calls[0][1].runId, "run-3");
  assert.equal(ledger.calls[1][1].actualCost, 0.005);
});

test("a 403 or 429 from the site goes to the second reader; a 404, a 401 or a 5xx does not", async (t) => {
  const visible = (words) => `<html><head><title>x</title></head><body><main><p>${words.repeat(30)}</p></main></body></html>`;
  const plain = (text, status) => ({ status, headers: { "content-type": "text/plain" }, body: Buffer.from(text) });
  const table = {
    // An HTML 403 is a WAF's answer to a plain client (webReadExtract's CHALLENGE_STATUSES): a challenge, like the 412s.
    "https://a.example.org/waf": html(visible("Access denied for this client. "), 403),
    "https://a.example.org/403": plain("Forbidden", 403),
    "https://a.example.org/429": plain("Too Many Requests", 429),
    "https://a.example.org/404": html(visible("No such page here. "), 404),
    "https://a.example.org/401": html(visible("Please sign in first. "), 401),
    "https://a.example.org/500": html(visible("Our server broke today. "), 500),
  };
  const deepseek = deepseekFetch();
  const read = await gateway(t, withKey, { transport: fakeTransport(table).transport, deepseek });
  assert.equal((await read("https://a.example.org/waf")).body.receipt.fallbackReason, "needs_browser");
  assert.equal((await read("https://a.example.org/403")).body.receipt.fallbackReason, "site_403");
  assert.equal((await read("https://a.example.org/429")).body.receipt.fallbackReason, "site_429");
  assert.equal((await read("https://a.example.org/404")).body.error.code, "web_read_not_found");
  assert.equal((await read("https://a.example.org/401")).body.error.code, "web_read_login_required");
  assert.equal((await read("https://a.example.org/500")).body.error.code, "web_read_upstream_error");
  assert.deepEqual(deepseek.sent.map((entry) => entry.body.url), ["https://a.example.org/waf", "https://a.example.org/403", "https://a.example.org/429"]);
});

test("robots.txt, a private or unresolvable host, a document and the size cap are decided before DeepSeek, which never hears of them", async (t) => {
  const deepseek = deepseekFetch();
  const { transport } = fakeTransport({
    "https://closed.example.org/robots.txt": { status: 200, headers: {}, body: Buffer.from("User-agent: *\nDisallow: /\n") },
    "https://bounce.example.org/r": html("", 302, { location: "http://169.254.169.254/latest/meta-data/" }),
    "https://files.example.org/guideline.pdf": html("<html><body><main><p>Forbidden for robots, go away now please.</p></main></body></html>", 403),
    "https://big.example.org/page": html(Buffer.alloc(80 * 1024, 0x61), 200, { "content-length": String(80 * 1024) }),
  });
  const read = await gateway(t, withKey, { transport: async (request) => {
    if (request.url.hostname === "big.example.org" && request.url.pathname !== "/robots.txt") throw webReadError(502, "web_read_response_too_large", "The web page exceeded the gateway's size limit.");
    return transport(request);
  }, deepseek });
  assert.equal((await read("https://closed.example.org/page")).body.error.code, "web_read_robots_disallowed");
  assert.equal((await read("https://bounce.example.org/r")).body.error.code, "web_read_host_forbidden");
  assert.equal((await read("http://10.0.0.8/admin")).body.error.code, "web_read_host_forbidden");
  assert.equal((await read("https://files.example.org/guideline.pdf")).body.error.code, "web_read_needs_browser", "a document stays on the parser path");
  assert.equal((await read("https://big.example.org/page")).body.error.code, "web_read_response_too_large");

  // Names this network resolves inward, or not at all, through the real pinned transport.
  const inward = await gateway(t, withKey, { transport: nodeWebTransport({ resolveImpl: async () => [{ address: "10.1.2.3", family: 4 }] }), resolveImpl: async () => [{ address: "10.1.2.3", family: 4 }], deepseek });
  assert.equal((await inward("https://intranet.example.org/wiki")).body.error.code, "web_read_host_forbidden");
  const nowhere = await gateway(t, withKey, { transport: nodeWebTransport({ resolveImpl: async () => { throw Object.assign(new Error("nx"), { code: "ENOTFOUND" }); } }), deepseek });
  assert.equal((await nowhere("https://corp-internal.example/wiki")).body.error.code, "web_read_host_unresolved");
  assert.deepEqual(deepseek.sent, [], "nothing above was sent to DeepSeek");
});

test("when the second reader fails too, the run gets our read's own reason, and the request is released, not billed", async (t) => {
  const page = "https://www.nmpa.gov.cn/xxgk/ggtg/index.html";
  for (const [reply, code] of [[answer(recorded["fetch-blocked"].body, 504), "provider_failed_504"], [answer({ error: { message: "x", type: "content_policy_error", param: null, code: "content_policy_error" } }, 403), "provider_refused_403"]]) {
    const ledger = fakeLedger();
    const read = await gateway(t, withKey, { transport: fakeTransport({ [page]: html(challenge, 412) }).transport, deepseek: deepseekFetch(reply), usageLedger: ledger });
    const { status, body } = await read(page);
    assert.equal(status, 422);
    assert.equal(body.error.code, "web_read_needs_browser");
    assert.match(body.error.message, /JavaScript challenge/);
    assert.deepEqual(ledger.calls.map(([kind, input]) => [kind, input.code ?? null]), [["reserve", null], ["release", code]]);
  }
  // An answer with no text is no reading of the page either, and is not billed.
  const ledger = fakeLedger();
  const empty = await gateway(t, withKey, { transport: fakeTransport({ [page]: html(challenge, 412) }).transport, deepseek: deepseekFetch(answer({ title: "t", content: "  " })), usageLedger: ledger });
  assert.equal((await empty(page)).body.error.code, "web_read_needs_browser");
  assert.deepEqual(ledger.calls.map(([kind, input]) => [kind, input.code ?? null]), [["reserve", null], ["release", "provider_no_result"]]);
});

test("a read that runs out of its share of the time still has the second reader's", async (t) => {
  const page = "https://slow.example.org/notice";
  const stalled = fakeTransport({
    [page]: (_url, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(webReadError(504, "web_read_timeout", "The web page did not answer in time.")), { once: true });
    }),
  });
  const deepseek = deepseekFetch();
  // 36 s in all: our read gets 1 s, DeepSeek's Fetch keeps its 35.
  const read = await gateway(t, { ...withKey, webReadTimeoutMs: 36_000 }, { transport: stalled.transport, deepseek });
  const started = Date.now();
  const { status, body } = await read(page);
  assert.equal(status, 200);
  assert.equal(body.receipt.fallbackReason, "timeout");
  assert.ok(Date.now() - started < 5_000, "our read stopped at its own share");

  const alone = await gateway(t, { ...readConfig, webReadTimeoutMs: 1_000 }, { transport: stalled.transport, deepseek: deepseekFetch() });
  assert.equal((await alone(page)).body.error.code, "web_read_timeout", "without a second reader a timeout is a timeout, as before");
});

test("switched off by its lever, or with no key, our read is the only reader", async (t) => {
  const page = "https://www.nmpa.gov.cn/xxgk/ggtg/index.html";
  for (const config of [{ ...withKey, webReadDeepseekFallbackEnabled: false }, { ...withKey, deepseekApiKey: "" }]) {
    const deepseek = deepseekFetch();
    const read = await gateway(t, config, { transport: fakeTransport({ [page]: html(challenge, 412) }).transport, deepseek });
    assert.equal((await read(page)).body.error.code, "web_read_needs_browser");
    assert.deepEqual(deepseek.sent, []);
  }
});

test("the reasons a second reader may be asked are a closed list", () => {
  const url = "https://example.org/page";
  assert.equal(webReadFallbackReason({ code: "web_read_needs_browser" }, url), "needs_browser");
  assert.equal(webReadFallbackReason({ code: "web_read_unreadable" }, url), "unreadable_after_render");
  assert.equal(webReadFallbackReason({ code: "web_render_timeout" }, url), "unreadable_after_render");
  assert.equal(webReadFallbackReason({ code: "web_read_upstream_unavailable" }, url), "unreachable");
  assert.equal(webReadFallbackReason({ code: "web_read_upstream_error", siteStatus: 403 }, url), "site_403");
  assert.equal(webReadFallbackReason({ code: "web_read_upstream_error", siteStatus: 503 }, url), null);
  assert.equal(webReadFallbackReason(new Error("x"), url, { timedOut: true }), "timeout");
  for (const code of ["web_read_robots_disallowed", "web_read_host_forbidden", "web_read_host_unresolved", "web_read_url_forbidden", "web_read_url_invalid", "web_read_response_too_large",
    "web_read_not_found", "web_read_login_required", "web_read_busy", "web_read_runtime_busy", "web_read_host_busy", "web_read_content_type_unsupported", "source_parser_failed", "web_read_aborted"]) {
    assert.equal(webReadFallbackReason({ code }, url), null, code);
  }
  assert.equal(webReadFallbackReason({ code: "web_read_needs_browser" }, "https://example.org/a/report.PDF"), null);
  assert.equal(webReadFallbackReason({ code: "web_read_needs_browser" }, "ftp://example.org/x"), null);
  assert.equal(webReadFallbackReason({ code: "web_read_needs_browser" }, "not a url"), null);
});

test("a rendition's text undoes only CommonMark's backslash escapes", () => {
  assert.equal(unescapedRendition(String.raw`base\_url \(OpenAI\) \| https\:\/\/api\.deepseek\.com`), "base_url (OpenAI) | https://api.deepseek.com");
  assert.equal(unescapedRendition(String.raw`a line \\`), String.raw`a line \\`.replace(/\\\\/, "\\"));
  assert.equal(unescapedRendition(String.raw`C:\path 中文\n`), String.raw`C:\path 中文\n`, "a backslash before a letter or a CJK character stays");
  const result = deepseekRenditionResult({ url: "https://example.org/x", title: "  T  ", content: String.raw`a\.b`, reason: "site_403", now: () => new Date("2026-10-17T12:00:00Z") });
  assert.equal(result.text, "a.b");
  assert.equal(result.receipt.title, "T");
  assert.equal(result.receipt.fetchedAt, "2026-10-17T12:00:00.000Z");
  assert.equal(result.receipt.sha256, createHash("sha256").update(String.raw`a\.b`).digest("hex"));
});
