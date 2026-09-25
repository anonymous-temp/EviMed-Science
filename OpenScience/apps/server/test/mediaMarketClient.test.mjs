// The vendor boundary: the documented request and answer shapes, what is
// retried and what never is, the key's handling, and "not configured" meaning
// nothing leaves the host.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";
import {
  MediaMarketClient,
  createMediaMarketClient,
  mediaMarketMetricFamilies,
  normalizeMediaRow,
  normalizeOrderRow,
} from "../src/mediaMarketClient.mjs";
import { startFakeMediaMarket, vendorRow } from "./helpers/fakeMediaMarket.mjs";

const quick = { minIntervalMs: 0, sleep: async () => {} };

/** @param {Array<Response | (() => Response) | Error>} answers */
function scriptedFetch(answers) {
  const calls = [];
  const fetchImpl = async (/** @type {any} */ url, /** @type {any} */ init) => {
    calls.push({ url: String(url), init });
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : /** @type {Response} */ (next);
  };
  return { fetchImpl: /** @type {typeof fetch} */ (/** @type {unknown} */ (fetchImpl)), calls };
}

const ok = (/** @type {any} */ data) => new Response(JSON.stringify({ code: 1, msg: "获取成功", time: "1768275264", data }), { status: 200 });

test("catalogue pages, category names and balance speak the documented shapes on both product lines", async () => {
  const fake = await startFakeMediaMarket({ catalogue: {
    website: [vendorRow({ resource_id: 73880, title: "\t（腾讯网新闻）中原视讯", field_9: "9001,9002,9003", publish_time: 0, price: "27.00" })],
    wemedia: [vendorRow({ resource_id: 5, title: "某健康号" })],
  } });
  try {
    const client = new MediaMarketClient({ baseUrl: fake.url, apiKey: fake.state.apiKey, ...quick });
    assert.equal(client.configured, true);
    const page = await client.mediaList("website", { page: 1, pageSize: 20 });
    assert.equal(page.received, 1);
    assert.deepEqual(page.rows[0], {
      resourceId: "73880", title: "（腾讯网新闻）中原视讯", remarks: "", caseLink: "https://www.health-a.cn/news/1.html",
      fields: { field_1: ["1007"], field_3: ["3001"], field_4: ["4001"], field_5: ["5001"], field_6: ["6001"], field_7: ["7024"], field_9: ["9001", "9002", "9003"] },
      pcWeight: 3, wapWeight: 3, publishRate: 85, publishSeconds: null, available: true, priceCny: 27,
    });
    assert.equal((await client.mediaList("wemedia", { page: 1, pageSize: 20 })).rows[0].resourceId, "5");
    assert.deepEqual(fake.state.requests.map((request) => request.path), ["/api/media/media_list", "/api/zi_media_api/media_list"]);
    assert.deepEqual(fake.state.requests[0].form, { api_key: fake.state.apiKey, page: "1", page_size: "20" });
    const names = await client.fields("website", "field_1");
    assert.deepEqual(names.find((row) => row.id === "1007"), { id: "1007", type: "field_1", title: "健康医疗", sort: 7 });
    assert.deepEqual(fake.state.requests.at(-1).form, { api_key: fake.state.apiKey, media_type: "website", field_type: "field_1" });
    assert.deepEqual(await client.balance(), { money: 1000, powerCount: 100 });
    await assert.rejects(client.mediaList("website", { page: 1, pageSize: 101 }), { code: "media_market_request_invalid" });
    await assert.rejects(client.mediaList(/** @type {any} */ ("b2b"), { page: 1, pageSize: 10 }), { code: "media_market_request_invalid" });
  } finally { await fake.close(); }
});

test("send, order info, cancel and appeal: fields, order numbers as strings, one order read back as a list", async () => {
  const fake = await startFakeMediaMarket({ catalogue: { website: [vendorRow({ resource_id: 101, price: "100.00" })] } });
  try {
    const client = new MediaMarketClient({ baseUrl: fake.url, apiKey: fake.state.apiKey, ...quick });
    const { orderNid } = await client.send("website", { resourceId: "101", title: "标题", contentHtml: "<p>正文 2.4 mg</p>", remark: "请勿改动", thirdId: "go_1" });
    assert.equal(typeof orderNid, "string");
    const form = fake.requestsTo("/api/media/send")[0].form;
    assert.deepEqual(form, { api_key: fake.state.apiKey, resource_id: "101", title: "标题", content: "<p>正文 2.4 mg</p>", remark: "请勿改动", third_id: "go_1" });
    const [info] = await client.orderInfo("website", [orderNid]);
    assert.deepEqual(info, { orderNid, resourceId: "101", status: 0, priceCny: 100, isRefund: false, title: "标题", remark: "请勿改动",
      rejectionInfo: "", refundInfo: "", rewriteInfo: "", orderUrl: null });
    assert.deepEqual(fake.requestsTo("/api/media/order_info")[0].form, { api_key: fake.state.apiKey, order_nids: orderNid });
    const second = (await client.send("website", { resourceId: "101", title: "二", contentHtml: "<p>二</p>", thirdId: "go_2" })).orderNid;
    assert.equal((await client.orderInfo("website", [orderNid, second])).length, 2);
    assert.deepEqual(fake.requestsTo("/api/media/order_info")[1].form["order_nids[]"], [orderNid, second]);
    assert.deepEqual(await client.orderInfo("wemedia", [orderNid]), [], "an order of the other line is not returned");
    assert.equal((await client.cancelOrder("website", orderNid)).ok, true);
    await assert.rejects(client.cancelOrder("website", orderNid), (error) => {
      assert.equal(/** @type {any} */ (error).code, "media_market_refused");
      assert.equal(/** @type {any} */ (error).vendorMessage, "投稿订单不存在或条件不符合");
      return true;
    });
    fake.setOrder(second, { status: 2, order_url: "https://www.health-a.cn/p/1.html" });
    assert.equal((await client.appeal("website", second, { titleId: 2, info: "正文被改：「2.4 mg」" })).ok, true);
    assert.deepEqual(fake.state.appeals, [{ order_nid: second, title_id: 2, info: "正文被改：「2.4 mg」" }]);
    await assert.rejects(client.appeal("website", second, { titleId: /** @type {any} */ (7), info: "" }), { code: "media_market_request_invalid" });
    await assert.rejects(client.send("website", { resourceId: "101", title: "", contentHtml: "<p>x</p>", thirdId: "go_3" }), { code: "media_market_request_invalid" });
    await assert.rejects(client.send("website", { resourceId: "101", title: "t", contentHtml: "x".repeat(600 * 1024), thirdId: "go_3" }), { code: "media_market_request_invalid" });
    await assert.rejects(client.orderInfo("website", Array.from({ length: 51 }, (_, index) => String(index))), { code: "media_market_request_invalid" });
  } finally { await fake.close(); }
});

test("a refusal names the vendor's reason, and the key it echoes is scrubbed", async () => {
  const fake = await startFakeMediaMarket({ catalogue: { website: [vendorRow({ resource_id: 101 })] } });
  try {
    const client = new MediaMarketClient({ baseUrl: fake.url, apiKey: fake.state.apiKey, ...quick });
    fake.state.sendMode = "echo_key";
    const error = await client.send("website", { resourceId: "101", title: "t", contentHtml: "<p>x</p>", thirdId: "go_1" }).catch((caught) => caught);
    assert.equal(error.code, "media_market_refused");
    assert.equal(error.vendorMessage, "投稿失败：api_key=[redacted] 无权限");
    for (const text of [error.message, error.vendorMessage, JSON.stringify(client.status())]) assert.ok(!text.includes(fake.state.apiKey));
    const wrong = new MediaMarketClient({ baseUrl: fake.url, apiKey: "some-other-key", ...quick });
    await assert.rejects(wrong.balance(), { code: "media_market_refused" });
  } finally { await fake.close(); }
});

test("reads are retried once on a gateway error; a send is never retried and its failure is unknown", async () => {
  const read = scriptedFetch([new Response("busy", { status: 503 }), ok({ power_count: 1, money: 5 })]);
  const reader = new MediaMarketClient({ baseUrl: "https://market.example.cn", apiKey: "k-123456", fetchImpl: read.fetchImpl, ...quick });
  assert.deepEqual(await reader.balance(), { money: 5, powerCount: 1 });
  assert.equal(read.calls.length, 2);
  assert.equal(reader.status().counters.retries, 1);

  const send = scriptedFetch([new Response("oops", { status: 500 }), ok({ order_nid: 1 })]);
  const sender = new MediaMarketClient({ baseUrl: "https://market.example.cn", apiKey: "k-123456", fetchImpl: send.fetchImpl, ...quick });
  await assert.rejects(sender.send("website", { resourceId: "1", title: "t", contentHtml: "<p>x</p>", thirdId: "go_1" }), { code: "media_market_send_unknown" });
  assert.equal(send.calls.length, 1, "never a second send");

  const garbled = scriptedFetch([new Response("<html>ok</html>", { status: 200 })]);
  const garbledSender = new MediaMarketClient({ baseUrl: "https://market.example.cn", apiKey: "k-123456", fetchImpl: garbled.fetchImpl, ...quick });
  await assert.rejects(garbledSender.send("website", { resourceId: "1", title: "t", contentHtml: "<p>x</p>", thirdId: "go_1" }), { code: "media_market_send_unknown" });
  const noNid = scriptedFetch([ok({})]);
  const noNidSender = new MediaMarketClient({ baseUrl: "https://market.example.cn", apiKey: "k-123456", fetchImpl: noNid.fetchImpl, ...quick });
  await assert.rejects(noNidSender.send("website", { resourceId: "1", title: "t", contentHtml: "<p>x</p>", thirdId: "go_1" }), { code: "media_market_send_unknown" });

  const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  const down = scriptedFetch([refused]);
  const downSender = new MediaMarketClient({ baseUrl: "https://market.example.cn", apiKey: "k-123456", fetchImpl: down.fetchImpl, ...quick });
  await assert.rejects(downSender.send("website", { resourceId: "1", title: "t", contentHtml: "<p>x</p>", thirdId: "go_1" }), { code: "media_market_unreachable" },
    "a connection that never opened provably sent nothing");

  const invalid = scriptedFetch([new Response("not json", { status: 200 }), new Response("not json", { status: 200 })]);
  const invalidReader = new MediaMarketClient({ baseUrl: "https://market.example.cn", apiKey: "k-123456", fetchImpl: invalid.fetchImpl, ...quick });
  await assert.rejects(invalidReader.balance(), { code: "media_market_response_invalid" });

  const unauthorized = scriptedFetch([new Response("no", { status: 401 })]);
  const unauthorizedReader = new MediaMarketClient({ baseUrl: "https://market.example.cn", apiKey: "k-123456", fetchImpl: unauthorized.fetchImpl, ...quick });
  await assert.rejects(unauthorizedReader.balance(), { code: "media_market_unauthorized" });
});

test("a send that times out after reaching the vendor is unknown", async () => {
  const fake = await startFakeMediaMarket({ catalogue: { website: [vendorRow({ resource_id: 101, price: "100.00" })] } });
  try {
    const client = new MediaMarketClient({ baseUrl: fake.url, apiKey: fake.state.apiKey, sendTimeoutMs: 200, ...quick });
    fake.state.sendMode = "timeout";
    await assert.rejects(client.send("website", { resourceId: "101", title: "t", contentHtml: "<p>x</p>", thirdId: "go_1" }), { code: "media_market_send_unknown" });
    assert.equal(fake.requestsTo("/api/media/send").length, 1);
    assert.equal(fake.state.orders.size, 1, "the vendor did create it");
    assert.equal(client.status().counters.sendUnknown, 1);
  } finally { await fake.close(); }
});

test("answers are size-bounded", async () => {
  const big = scriptedFetch([ok(Array.from({ length: 200 }, () => vendorRow({}))), ok(Array.from({ length: 200 }, () => vendorRow({})))]);
  const client = new MediaMarketClient({ baseUrl: "https://market.example.cn", apiKey: "k-123456", fetchImpl: big.fetchImpl, maxResponseBytes: 4096, ...quick });
  await assert.rejects(client.mediaList("website", { page: 1, pageSize: 100 }), { code: "media_market_response_too_large" });
});

test("not configured: nothing is sent anywhere", async () => {
  const none = scriptedFetch([]);
  for (const options of [{}, { baseUrl: "https://market.example.cn" }, { apiKey: "k-123456" },
    { baseUrl: "https://market.example.cn", apiKeyFile: path.join(os.tmpdir(), "no-such-media-market-key") }]) {
    const client = new MediaMarketClient({ ...options, fetchImpl: none.fetchImpl, ...quick });
    assert.equal(client.configured, false, JSON.stringify(options));
    await assert.rejects(client.balance(), { code: "media_market_unconfigured" });
    await assert.rejects(client.send("website", { resourceId: "1", title: "t", contentHtml: "<p>x</p>", thirdId: "go_1" }), { code: "media_market_unconfigured" });
  }
  assert.equal(none.calls.length, 0);
  assert.equal(createMediaMarketClient({}).configured, false);
  assert.deepEqual(mediaMarketMetricFamilies(createMediaMarketClient({}).status())[0].series, [{ value: 0 }]);
});

test("the key file is read on every call, owner-only, never echoed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "media-market-key-"));
  const file = path.join(dir, "media-market.api-key");
  const fake = await startFakeMediaMarket({});
  try {
    fs.writeFileSync(file, `${fake.state.apiKey}\n`, { mode: 0o600 });
    const client = new MediaMarketClient({ baseUrl: fake.url, apiKeyFile: file, ...quick });
    assert.equal(client.configured, true);
    assert.equal((await client.balance()).money, 1000);
    assert.equal(fake.state.requests.at(-1).form.api_key, fake.state.apiKey);
    fs.chmodSync(file, 0o644);
    const error = await client.balance().catch((caught) => caught);
    assert.equal(error.code, "media_market_unconfigured");
    assert.match(error.message, /key_file_permissions/);
    assert.ok(!error.message.includes(fake.state.apiKey));
    fs.chmodSync(file, 0o600);
    fs.writeFileSync(file, "rotated-key-999\n", { mode: 0o600 });
    await assert.rejects(client.balance(), { code: "media_market_refused" }, "a rotation is a file write");
    const link = path.join(dir, "link");
    fs.symlinkSync(file, link);
    const viaLink = new MediaMarketClient({ baseUrl: fake.url, apiKeyFile: link, ...quick });
    assert.equal(viaLink.configured, false, "a link is not the key file");
    await assert.rejects(viaLink.balance(), /key_file_symlink/);
  } finally {
    await fake.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("plaintext is refused except on loopback or by the operator's word", () => {
  assert.throws(() => new MediaMarketClient({ baseUrl: "http://dev-cn.your-api-server.com", apiKey: "k" }), /must be https/);
  assert.equal(new MediaMarketClient({ baseUrl: "http://dev-cn.your-api-server.com", apiKey: "k", allowPlaintext: true }).configured, true);
  assert.equal(new MediaMarketClient({ baseUrl: "http://127.0.0.1:9", apiKey: "k" }).configured, true);
  assert.throws(() => new MediaMarketClient({ baseUrl: "https://user:placeholder@market.example.cn", apiKey: "k" }), /invalid/);
});

test("calls are paced", async () => {
  /** @type {number[]} */
  const waits = [];
  const paced = scriptedFetch([ok({ money: 1, power_count: 1 }), ok({ money: 1, power_count: 1 })]);
  const client = new MediaMarketClient({ baseUrl: "https://market.example.cn", apiKey: "k-123456", fetchImpl: paced.fetchImpl,
    minIntervalMs: 600, sleep: async (ms) => { waits.push(Number(ms)); } });
  await client.balance();
  await client.balance();
  assert.equal(waits.length, 1);
  assert.ok(waits[0] > 500 && waits[0] <= 600, String(waits[0]));
});

test("the 查收录 trio", async () => {
  const fake = await startFakeMediaMarket({});
  try {
    const client = new MediaMarketClient({ baseUrl: fake.url, apiKey: fake.state.apiKey, ...quick });
    const { requestId } = await client.addInclusionTask({ platform: 5, keywords: ["诺和泰", "司美,格鲁肽"], question: "减重针哪个好", thirdId: "gi_1" });
    assert.deepEqual(fake.requestsTo("/api/geo/add_shoulu")[0].form, { api_key: fake.state.apiKey, platform: "5", keywords: "诺和泰,司美 格鲁肽", question: "减重针哪个好", third_id: "gi_1" });
    const pending = await client.checkInclusionTask(requestId);
    assert.equal(pending.status, 0);
    assert.equal(pending.platform, 5);
    assert.deepEqual(await client.cancelInclusionTasks([requestId]), { cancelled: [requestId] });
    await assert.rejects(client.cancelInclusionTasks([requestId]), { code: "media_market_refused" });
    await assert.rejects(client.addInclusionTask({ platform: 9, keywords: ["x"], question: "q", thirdId: "gi_2" }), { code: "media_market_request_invalid" });
  } finally { await fake.close(); }
});

test("rows the vendor garbles are dropped or degraded, never guessed", () => {
  assert.equal(normalizeMediaRow({ title: "no id" }), null);
  assert.equal(normalizeMediaRow("x"), null);
  const row = normalizeMediaRow({ resource_id: "12", title: "t", price: "abc", publish_rate: "150", status: "0", case_link: "javascript:alert(1)" });
  assert.equal(row?.priceCny, null);
  assert.equal(row?.publishRate, null);
  assert.equal(row?.available, false);
  assert.equal(row?.caseLink, null);
  assert.equal(normalizeOrderRow({ order_nid: "12 34" }), null);
  assert.equal(normalizeOrderRow({ order_nid: 2026, status: 7, is_refund: "1" })?.status, 7, "an unknown status is kept raw for the mapping to refuse");
});

test("configuration: the market's keys parse and refuse what cannot work", () => {
  const config = loadConfig({ mediaMarketUrl: "https://market.example.cn/", mediaMarketApiKeyFile: "/run/secrets/media-market-key", mediaMarketBalanceCapCny: "5000",
    geoInclusionEngines: ["Baidu", "baidu", " "] });
  assert.equal(config.mediaMarketUrl, "https://market.example.cn");
  assert.equal(config.mediaMarketApiKeyFile, "/run/secrets/media-market-key");
  assert.equal(config.mediaMarketBalanceCapCny, 5000);
  assert.deepEqual(config.geoInclusionEngines, ["baidu"]);
  assert.equal(config.mediaMarketTimeoutMs, 15_000);
  assert.equal(loadConfig({}).mediaMarketBalanceCapCny, null);
  assert.equal(loadConfig({}).mediaMarketUrl, "");
  assert.throws(() => loadConfig({ mediaMarketUrl: "ftp://x" }), /OPEN_SCIENCE_MEDIA_MARKET_URL/);
  assert.throws(() => loadConfig({ mediaMarketApiKeyFile: "relative/key" }), /OPEN_SCIENCE_MEDIA_MARKET_API_KEY_FILE/);
  assert.throws(() => loadConfig({ mediaMarketBalanceCapCny: "-1" }), /OPEN_SCIENCE_MEDIA_MARKET_BALANCE_CAP_CNY/);
});

test("a refused connection never counts as sent (real socket)", async () => {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  const client = new MediaMarketClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "k-123456", ...quick });
  await assert.rejects(client.send("website", { resourceId: "1", title: "t", contentHtml: "<p>x</p>", thirdId: "go_1" }), { code: "media_market_unreachable" });
});
