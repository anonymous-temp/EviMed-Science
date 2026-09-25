// 循证 GEO's settings and the media marketplace's: the build spec's defaults,
// every lever read from the environment, and every value outside its range
// refused at start by the variable's name.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";
import { MCP_TOOL_CALL_TIMEOUT_MS } from "../src/dshProfilePatch.mjs";
import { geoAudienceAllows, geoMarketConfigured } from "../src/geoService.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** loadConfig under exactly `env`. @param {Record<string, string>} env */
function configUnder(env) {
  const saved = process.env;
  process.env = { ...env };
  try { return loadConfig({ rootDir: repoRoot }); } finally { process.env = saved; }
}

const KEYS = ["geoEnabled", "geoAudience", "geoPreviewUsers", "geoPollMs", "geoLeaseMs", "geoDailyBudgetCny", "geoEngines", "geoNightWindow",
  "geoTimeZone", "geoWeeklyAskCap", "geoSocialUrl", "geoSocialTimeoutMs", "geoInclusionEngines", "mediaMarketUrl", "mediaMarketApiKeyFile",
  "mediaMarketBalanceCapCny"];

/** @param {Record<string, any>} config */
const pick = (config) => Object.fromEntries(KEYS.map((key) => [key, config[key]]));

test("the defaults are the build spec's: off, operators only once on, five engines, 22-07 in Shanghai, nothing wired", () => {
  assert.deepEqual(pick(configUnder({})), {
    geoEnabled: false, geoAudience: "operators", geoPreviewUsers: [], geoPollMs: 5_000, geoLeaseMs: 600_000, geoDailyBudgetCny: 20,
    geoEngines: ["doubao", "qianwen", "deepseek", "yuanbao", "kimi"], geoNightWindow: "22-07", geoTimeZone: "Asia/Shanghai",
    geoWeeklyAskCap: 1_500, geoSocialUrl: "", geoSocialTimeoutMs: 120_000, geoInclusionEngines: [], mediaMarketUrl: "", mediaMarketApiKeyFile: "",
    mediaMarketBalanceCapCny: null,
  });
});

test("every lever is read from the environment, and an empty value reads as unset", () => {
  const config = configUnder({
    OPEN_SCIENCE_GEO_ENABLED: "true", OPEN_SCIENCE_GEO_AUDIENCE: "all", OPEN_SCIENCE_GEO_PREVIEW_USERS: "acceptance, qa",
    OPEN_SCIENCE_GEO_POLL_MS: "2000", OPEN_SCIENCE_GEO_LEASE_MS: "", OPEN_SCIENCE_GEO_DAILY_BUDGET_CNY: "0",
    OPEN_SCIENCE_GEO_ENGINES: "deepseek, doubao", OPEN_SCIENCE_GEO_NIGHT_WINDOW: "23-6", OPEN_SCIENCE_GEO_TIMEZONE: "UTC",
    OPEN_SCIENCE_GEO_WEEKLY_ASK_CAP: "600", OPEN_SCIENCE_GEO_SOCIAL_URL: "http://social.internal:9966/", OPEN_SCIENCE_GEO_SOCIAL_TIMEOUT_MS: "90000",
    OPEN_SCIENCE_GEO_INCLUSION_ENGINES: "baidu", OPEN_SCIENCE_MEDIA_MARKET_URL: "https://market.example/", OPEN_SCIENCE_MEDIA_MARKET_API_KEY_FILE: "/run/secrets/media",
    OPEN_SCIENCE_MEDIA_MARKET_BALANCE_CAP_CNY: "20000",
  });
  assert.deepEqual(pick(config), {
    geoEnabled: true, geoAudience: "all", geoPreviewUsers: ["acceptance", "qa"], geoPollMs: 2_000, geoLeaseMs: 600_000, geoDailyBudgetCny: 0,
    geoEngines: ["deepseek", "doubao"], geoNightWindow: "23-6", geoTimeZone: "UTC", geoWeeklyAskCap: 600, geoSocialUrl: "http://social.internal:9966",
    geoSocialTimeoutMs: 90_000, geoInclusionEngines: ["baidu"], mediaMarketUrl: "https://market.example", mediaMarketApiKeyFile: "/run/secrets/media",
    mediaMarketBalanceCapCny: 20_000,
  });
  // Wired means a usable key file (mediaMarketConfigured): a path alone is not
  // a key, and the /dev/null compose binds where there is none is not either.
  const keyDir = mkdtempSync(path.join(os.tmpdir(), "geo-config-key-"));
  try {
    const keyFile = path.join(keyDir, "media-market-api-key");
    writeFileSync(keyFile, "k-123456\n", { mode: 0o600 });
    assert.equal(geoMarketConfigured({ ...config, mediaMarketApiKeyFile: keyFile }), true);
  } finally { rmSync(keyDir, { recursive: true, force: true }); }
  assert.equal(geoMarketConfigured(config), false, "a key file that is not there is not a key");
  assert.equal(geoMarketConfigured({ ...config, mediaMarketApiKeyFile: "/dev/null" }), false, "the empty bind is not a key");
  assert.equal(geoMarketConfigured({ ...config, mediaMarketApiKeyFile: "" }), false, "an address without a key is not wired");
});

test("a value outside its range stops the start by the variable's name", () => {
  const ceiling = MCP_TOOL_CALL_TIMEOUT_MS;
  for (const [name, value] of [
    ["OPEN_SCIENCE_GEO_AUDIENCE", "everyone"],
    ["OPEN_SCIENCE_GEO_POLL_MS", "0"],
    ["OPEN_SCIENCE_GEO_LEASE_MS", "1000"],
    ["OPEN_SCIENCE_GEO_DAILY_BUDGET_CNY", "-1"],
    ["OPEN_SCIENCE_GEO_ENGINES", "deepseek,bing"],
    ["OPEN_SCIENCE_GEO_ENGINES", "deepseek,deepseek"],
    ["OPEN_SCIENCE_GEO_ENGINES", "wenxin"],
    ["OPEN_SCIENCE_GEO_NIGHT_WINDOW", "22:00-07:00"],
    ["OPEN_SCIENCE_GEO_NIGHT_WINDOW", "7-7"],
    ["OPEN_SCIENCE_GEO_NIGHT_WINDOW", "22-24"],
    ["OPEN_SCIENCE_GEO_TIMEZONE", "Mars/Olympus"],
    ["OPEN_SCIENCE_GEO_WEEKLY_ASK_CAP", "1.5"],
    ["OPEN_SCIENCE_GEO_SOCIAL_URL", "http://someone:test-only@social.internal"],
    ["OPEN_SCIENCE_GEO_SOCIAL_URL", "ftp://social.internal"],
    ["OPEN_SCIENCE_GEO_SOCIAL_TIMEOUT_MS", String(ceiling)],
    ["OPEN_SCIENCE_GEO_INCLUSION_ENGINES", "google"],
    ["OPEN_SCIENCE_MEDIA_MARKET_URL", "market.example"],
    ["OPEN_SCIENCE_MEDIA_MARKET_API_KEY_FILE", "relative/key"],
    ["OPEN_SCIENCE_MEDIA_MARKET_BALANCE_CAP_CNY", "0"],
  ]) {
    assert.throws(() => configUnder({ [name]: value }), (error) => error instanceof Error && error.message.includes(name), `${name}=${value}`);
  }
  // The social timeout stays under the kernel's tool-call ceiling with room for the gateway to answer.
  assert.ok(configUnder({}).geoSocialTimeoutMs + 5_000 < ceiling - 20_000);
});

test("the audience is the module on, and either everyone or an operator or a preview account (by id)", () => {
  const on = { geoEnabled: true, geoAudience: "operators", operatorUsers: ["ops"], geoPreviewUsers: ["acceptance"] };
  assert.equal(geoAudienceAllows(on, { id: "ops" }), true);
  assert.equal(geoAudienceAllows(on, { id: "acceptance" }), true);
  assert.equal(geoAudienceAllows(on, { id: "reader" }), false);
  assert.equal(geoAudienceAllows(on, { id: "" }), false);
  assert.equal(geoAudienceAllows({ ...on, geoAudience: "all" }, { id: "reader" }), true);
  assert.equal(geoAudienceAllows({ ...on, geoEnabled: false, geoAudience: "all" }, { id: "ops" }), false);
});
