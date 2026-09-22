// The frontier feed's settings: the defaults the build spec names, and every
// value outside its range refused at start by the variable's name.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** loadConfig under exactly `env`. @param {Record<string, string>} env */
function configUnder(env) {
  const saved = process.env;
  process.env = { ...env };
  try { return loadConfig({ rootDir: repoRoot }); } finally { process.env = saved; }
}

test("the defaults are the build spec's: off, open to all once on, and no plugin", () => {
  const config = configUnder({});
  assert.deepEqual({
    frontierEnabled: config.frontierEnabled, frontierAudience: config.frontierAudience, frontierPreviewUsers: config.frontierPreviewUsers,
    frontierPollMs: config.frontierPollMs, frontierLeaseMs: config.frontierLeaseMs, frontierModel: config.frontierModel,
    frontierDailyTime: config.frontierDailyTime, frontierTimeZone: config.frontierTimeZone, frontierDailyBudgetCny: config.frontierDailyBudgetCny,
    frontierProcessConcurrency: config.frontierProcessConcurrency, frontierOffpeak: config.frontierOffpeak,
    frontierSelectThreshold: config.frontierSelectThreshold, knowledgePluginUrl: config.knowledgePluginUrl,
    knowledgePluginTokenFile: config.knowledgePluginTokenFile, knowledgePluginPollMs: config.knowledgePluginPollMs,
    knowledgePluginTimeoutMs: config.knowledgePluginTimeoutMs, knowledgePluginMinContract: config.knowledgePluginMinContract,
  }, {
    frontierEnabled: false, frontierAudience: "all", frontierPreviewUsers: [], frontierPollMs: 5_000, frontierLeaseMs: 600_000,
    frontierModel: "deepseek-flash", frontierDailyTime: "07:30", frontierTimeZone: "Asia/Shanghai", frontierDailyBudgetCny: 10,
    frontierProcessConcurrency: 2, frontierOffpeak: true, frontierSelectThreshold: 70, knowledgePluginUrl: "",
    knowledgePluginTokenFile: "/run/secrets/knowledge-plugin-token", knowledgePluginPollMs: 60_000, knowledgePluginTimeoutMs: 8_000,
    knowledgePluginMinContract: "1.0",
  });
});

test("every lever is read from the environment, and an empty value reads as unset", () => {
  const config = configUnder({
    OPEN_SCIENCE_FRONTIER_ENABLED: "true", OPEN_SCIENCE_FRONTIER_AUDIENCE: "operators", OPEN_SCIENCE_FRONTIER_PREVIEW_USERS: "acceptance, qa",
    OPEN_SCIENCE_FRONTIER_POLL_MS: "2000", OPEN_SCIENCE_FRONTIER_LEASE_MS: "", OPEN_SCIENCE_FRONTIER_MODEL: "deepseek-v4-flash",
    OPEN_SCIENCE_FRONTIER_DAILY_TIME: "08:05", OPEN_SCIENCE_FRONTIER_TIMEZONE: "UTC", OPEN_SCIENCE_FRONTIER_DAILY_BUDGET_CNY: "0",
    OPEN_SCIENCE_FRONTIER_PROCESS_CONCURRENCY: "4", OPEN_SCIENCE_FRONTIER_OFFPEAK: "false", OPEN_SCIENCE_FRONTIER_SELECT_THRESHOLD: "65",
    OPEN_SCIENCE_KNOWLEDGE_PLUGIN_URL: "http://evimed-knowledge-plugin:8080/", OPEN_SCIENCE_KNOWLEDGE_PLUGIN_TOKEN_FILE: "/tmp/token",
    OPEN_SCIENCE_KNOWLEDGE_PLUGIN_POLL_MS: "30000", OPEN_SCIENCE_KNOWLEDGE_PLUGIN_TIMEOUT_MS: "5000", OPEN_SCIENCE_KNOWLEDGE_PLUGIN_MIN_CONTRACT: "1.1",
  });
  assert.equal(config.frontierEnabled, true);
  assert.equal(config.frontierAudience, "operators");
  assert.deepEqual(config.frontierPreviewUsers, ["acceptance", "qa"]);
  assert.equal(config.frontierPollMs, 2_000);
  assert.equal(config.frontierLeaseMs, 600_000, "an empty value is the default, not 0");
  assert.equal(config.frontierModel, "deepseek-v4-flash");
  assert.equal(config.frontierDailyBudgetCny, 0);
  assert.equal(config.frontierOffpeak, false);
  assert.equal(config.knowledgePluginUrl, "http://evimed-knowledge-plugin:8080", "the trailing slash is not part of the origin");
  assert.equal(config.knowledgePluginMinContract, "1.1");
});

test("a value outside its range stops the start by the variable's name", () => {
  for (const [name, value] of [
    ["OPEN_SCIENCE_FRONTIER_AUDIENCE", "everyone"],
    ["OPEN_SCIENCE_FRONTIER_POLL_MS", "10"],
    ["OPEN_SCIENCE_FRONTIER_POLL_MS", "2500.5"],
    ["OPEN_SCIENCE_FRONTIER_LEASE_MS", "1000"],
    ["OPEN_SCIENCE_FRONTIER_MODEL", "gpt-4o"],
    ["OPEN_SCIENCE_FRONTIER_DAILY_TIME", "7:30"],
    ["OPEN_SCIENCE_FRONTIER_TIMEZONE", "Mars/Olympus"],
    ["OPEN_SCIENCE_FRONTIER_DAILY_BUDGET_CNY", "-1"],
    ["OPEN_SCIENCE_FRONTIER_DAILY_BUDGET_CNY", "lots"],
    ["OPEN_SCIENCE_FRONTIER_PROCESS_CONCURRENCY", "9"],
    ["OPEN_SCIENCE_FRONTIER_SELECT_THRESHOLD", "101"],
    ["OPEN_SCIENCE_KNOWLEDGE_PLUGIN_URL", "ftp://plugin"],
    ["OPEN_SCIENCE_KNOWLEDGE_PLUGIN_URL", "http://someone:test-only@plugin:8080"],
    ["OPEN_SCIENCE_KNOWLEDGE_PLUGIN_TOKEN_FILE", "relative/token"],
    ["OPEN_SCIENCE_KNOWLEDGE_PLUGIN_POLL_MS", "1000"],
    ["OPEN_SCIENCE_KNOWLEDGE_PLUGIN_TIMEOUT_MS", "120000"],
    ["OPEN_SCIENCE_KNOWLEDGE_PLUGIN_MIN_CONTRACT", "v1"],
  ]) {
    assert.throws(() => configUnder({ [name]: value }), new RegExp(name), `${name}=${value}`);
  }
});
