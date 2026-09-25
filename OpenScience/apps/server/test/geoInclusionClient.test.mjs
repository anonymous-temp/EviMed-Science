// 「GEO 查收录」 as a mention-only channel: on only for Baidu, only with the
// market configured, and answering a snapshot-like record.
import assert from "node:assert/strict";
import test from "node:test";
import { GeoInclusionClient, INCLUSION_PLATFORMS, inclusionEnabled } from "../src/geoInclusionClient.mjs";
import { MediaMarketClient } from "../src/mediaMarketClient.mjs";
import { startFakeMediaMarket } from "./helpers/fakeMediaMarket.mjs";

const quick = { minIntervalMs: 0, sleep: async () => {} };

test("the vendor's platform numbers", () => {
  assert.deepEqual({ ...INCLUSION_PLATFORMS }, { deepseek: 1, doubao: 2, yuanbao: 3, qianwen: 4, baidu: 5, nami: 6, kimi: 7, zhipu: 8 });
});

test("on only when the market is configured and the engines list names baidu", () => {
  const configured = { configured: true };
  assert.equal(inclusionEnabled({ geoInclusionEngines: ["baidu"] }, configured), true);
  assert.equal(inclusionEnabled({ geoInclusionEngines: ["baidu"] }, { configured: false }), false);
  assert.equal(inclusionEnabled({ geoInclusionEngines: ["deepseek"] }, configured), false, "only Baidu goes through this channel");
  assert.equal(inclusionEnabled({ geoInclusionEngines: ["wenxin"] }, configured), false);
  assert.equal(inclusionEnabled({}, configured), false);
});

test("submit and poll map the vendor's task to a snapshot-like record", async () => {
  const fake = await startFakeMediaMarket({});
  try {
    const market = new MediaMarketClient({ baseUrl: fake.url, apiKey: fake.state.apiKey, ...quick });
    const client = new GeoInclusionClient({ market, config: { geoInclusionEngines: ["baidu", "kimi"] } });
    assert.deepEqual(client.engines(), ["baidu"]);
    const { requestId, engine } = await client.submit({ engine: "baidu", keywords: ["诺和泰", "司美格鲁肽"], question: "减重针哪个好", thirdId: "gs_1" });
    assert.equal(engine, "baidu");
    assert.equal(fake.requestsTo("/api/geo/add_shoulu")[0].form.platform, "5");
    assert.equal(fake.state.balance.power_count, 99, "one 算力 per task");
    assert.deepEqual(await client.poll("baidu", requestId), {
      engine: "baidu", surface: { mode: "inclusion" }, status: "pending", hit: null, keywordRes: "", screenshotUrl: null, shareUrl: null,
      requestId, checkedAt: null, inclusionDate: null,
    });
    Object.assign(fake.state.tasks.get(requestId), { status: 1, keyword_res: "诺和泰", img_url: "https://img.example.cn/a.png",
      share_url: "https://share.example.cn/a", shoulu_date: "2026-09-25", script_time: 1_790_000_000 });
    const hit = await client.poll("baidu", requestId);
    assert.equal(hit.status, "valid");
    assert.equal(hit.hit, true);
    assert.equal(hit.keywordRes, "诺和泰");
    assert.equal(hit.screenshotUrl, "https://img.example.cn/a.png");
    assert.equal(hit.shareUrl, "https://share.example.cn/a");
    assert.equal(hit.inclusionDate, "2026-09-25");
    assert.equal(hit.checkedAt, new Date(1_790_000_000_000).toISOString());
    Object.assign(fake.state.tasks.get(requestId), { status: 2 });
    assert.deepEqual([(await client.poll("baidu", requestId)).status, (await client.poll("baidu", requestId)).hit], ["valid", false]);
    Object.assign(fake.state.tasks.get(requestId), { status: 3 });
    assert.deepEqual([(await client.poll("baidu", requestId)).status, (await client.poll("baidu", requestId)).hit], ["failed", null]);
    await assert.rejects(client.submit({ engine: "kimi", keywords: ["x"], question: "q", thirdId: "gs_2" }), { code: "geo_inclusion_engine_not_allowed" });
  } finally { await fake.close(); }
});

test("disabled: nothing is sent", async () => {
  const fake = await startFakeMediaMarket({});
  try {
    const unconfigured = new GeoInclusionClient({ market: new MediaMarketClient({ ...quick }), config: { geoInclusionEngines: ["baidu"] } });
    assert.deepEqual(unconfigured.engines(), []);
    await assert.rejects(unconfigured.submit({ engine: "baidu", keywords: ["x"], question: "q", thirdId: "gs_1" }), { code: "geo_inclusion_disabled" });
    const unlisted = new GeoInclusionClient({ market: new MediaMarketClient({ baseUrl: fake.url, apiKey: fake.state.apiKey, ...quick }), config: {} });
    await assert.rejects(unlisted.submit({ engine: "baidu", keywords: ["x"], question: "q", thirdId: "gs_1" }), { code: "geo_inclusion_disabled" });
    await assert.rejects(unlisted.cancel(["rq1"]), { code: "geo_inclusion_disabled" });
    assert.equal(fake.state.requests.length, 0);
  } finally { await fake.close(); }
});
