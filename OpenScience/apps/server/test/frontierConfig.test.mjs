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
    frontierSelectThreshold: config.frontierSelectThreshold, frontierPreprintLanePerDay: config.frontierPreprintLanePerDay,
    frontierPreprintLaneMinScore: config.frontierPreprintLaneMinScore, frontierSafetyPushDailyCap: config.frontierSafetyPushDailyCap,
    knowledgePluginUrl: config.knowledgePluginUrl,
    knowledgePluginTokenFile: config.knowledgePluginTokenFile, knowledgePluginPollMs: config.knowledgePluginPollMs,
    knowledgePluginTimeoutMs: config.knowledgePluginTimeoutMs, knowledgePluginMinContract: config.knowledgePluginMinContract,
  }, {
    frontierEnabled: false, frontierAudience: "all", frontierPreviewUsers: [], frontierPollMs: 5_000, frontierLeaseMs: 600_000,
    frontierModel: "deepseek-flash", frontierDailyTime: "07:30", frontierTimeZone: "Asia/Shanghai", frontierDailyBudgetCny: 300,
    frontierProcessConcurrency: 2, frontierOffpeak: false, frontierSelectThreshold: 64, frontierPreprintLanePerDay: 2, frontierPreprintLaneMinScore: 50,
    frontierSafetyPushDailyCap: 3, knowledgePluginUrl: "",
    knowledgePluginTokenFile: "/run/secrets/knowledge-plugin-token", knowledgePluginPollMs: 60_000, knowledgePluginTimeoutMs: 8_000,
    knowledgePluginMinContract: "1.0",
  });
});

test("the selection line has one default: the config's, the pipeline's fallback and the example .env agree", async () => {
  const { FRONTIER_SELECT_THRESHOLD_DEFAULT, frontierSelectThreshold } = await import("../src/frontierPipeline.mjs");
  const { readFile } = await import("node:fs/promises");
  assert.equal(configUnder({}).frontierSelectThreshold, FRONTIER_SELECT_THRESHOLD_DEFAULT);
  assert.equal(frontierSelectThreshold({}), FRONTIER_SELECT_THRESHOLD_DEFAULT);
  const example = await readFile(path.join(repoRoot, "deploy/web/.env.example"), "utf8");
  const lines = [...example.matchAll(/^OPEN_SCIENCE_FRONTIER_SELECT_THRESHOLD=(\d+)$/gm)];
  assert.equal(lines.length, 1, "the example names the line once");
  assert.equal(Number(lines[0][1]), FRONTIER_SELECT_THRESHOLD_DEFAULT);
});

test("the daily budget has one default: the config's, the pipeline's fallback and the example .env agree, and it is the owner's ¥300", async () => {
  const { FRONTIER_DAILY_BUDGET_CNY_DEFAULT, FrontierPipeline } = await import("../src/frontierPipeline.mjs");
  const { readFile } = await import("node:fs/promises");
  assert.equal(FRONTIER_DAILY_BUDGET_CNY_DEFAULT, 300);
  assert.equal(configUnder({}).frontierDailyBudgetCny, FRONTIER_DAILY_BUDGET_CNY_DEFAULT);
  const pipeline = (/** @type {Record<string, any>} */ config) => new FrontierPipeline({ database: {}, editor: { screen() {}, edit() {} }, plugin: { text() {} }, config }).budgetCny;
  assert.equal(pipeline({}), FRONTIER_DAILY_BUDGET_CNY_DEFAULT);
  assert.equal(pipeline({ frontierDailyBudgetCny: 0 }), 0, "0 is no cap, not the default");
  assert.equal(pipeline({ frontierDailyBudgetCny: 12.5 }), 12.5);
  const example = await readFile(path.join(repoRoot, "deploy/web/.env.example"), "utf8");
  assert.equal([...example.matchAll(/^OPEN_SCIENCE_FRONTIER_DAILY_BUDGET_CNY=(\d+)$/gm)].map((match) => Number(match[1])).join(), "300");
});

test("the preprint lane has one default for each number: the config's, the pipeline's fallback and the example .env agree", async () => {
  const { FRONTIER_LANE_FLOOR_SCORE, FRONTIER_PREPRINT_LANE_MIN_SCORE_DEFAULT, FRONTIER_PREPRINT_LANE_PER_DAY_DEFAULT, frontierPreprintLaneMinScore,
    frontierPreprintLanePerDay } = await import("../src/frontierPipeline.mjs");
  const { readFile } = await import("node:fs/promises");
  assert.equal(configUnder({}).frontierPreprintLanePerDay, FRONTIER_PREPRINT_LANE_PER_DAY_DEFAULT);
  assert.equal(configUnder({}).frontierPreprintLaneMinScore, FRONTIER_PREPRINT_LANE_MIN_SCORE_DEFAULT);
  assert.equal(frontierPreprintLanePerDay({}), FRONTIER_PREPRINT_LANE_PER_DAY_DEFAULT);
  assert.equal(frontierPreprintLaneMinScore({}), FRONTIER_PREPRINT_LANE_MIN_SCORE_DEFAULT);
  const example = await readFile(path.join(repoRoot, "deploy/web/.env.example"), "utf8");
  const compose = await readFile(path.join(repoRoot, "deploy/web/docker-compose.yml"), "utf8");
  for (const [name, value] of [["OPEN_SCIENCE_FRONTIER_PREPRINT_LANE_PER_DAY", FRONTIER_PREPRINT_LANE_PER_DAY_DEFAULT], ["OPEN_SCIENCE_FRONTIER_PREPRINT_LANE_MIN_SCORE", FRONTIER_PREPRINT_LANE_MIN_SCORE_DEFAULT]]) {
    assert.equal([...example.matchAll(new RegExp(`^${name}=(\\d+)$`, "gm"))].map((match) => Number(match[1])).join(), String(value), `${name}: the example names the default once`);
    assert.match(compose, new RegExp(`^\\s+${name}:\\s*$`, "m"), `${name} reaches the web container value-less`);
  }
  // The lane asks what the domain's mix asks of a preprint, and the lane floor is the mix's floor (c3-select 2026-10-25: the
  // preprint's own bar is lower than the floor's, because a preprint's score is capped by what is known of it).
  const { FRONTIER_MIX_FLOOR_SCORE, FRONTIER_MIX_PREPRINT_MIN_SCORE } = await import("@evimed/domain");
  assert.equal(FRONTIER_PREPRINT_LANE_MIN_SCORE_DEFAULT, FRONTIER_MIX_PREPRINT_MIN_SCORE);
  assert.equal(FRONTIER_LANE_FLOOR_SCORE, FRONTIER_MIX_FLOOR_SCORE);
});

test("the safety push ceiling has one default: the config's, the notifier's fallback and the example .env agree, and it is the owner's three", async () => {
  const { FRONTIER_SAFETY_PUSH_DAILY_CAP_DEFAULT, FrontierNotifications } = await import("../src/frontierNotifications.mjs");
  const { readFile } = await import("node:fs/promises");
  assert.equal(FRONTIER_SAFETY_PUSH_DAILY_CAP_DEFAULT, 3);
  assert.equal(configUnder({}).frontierSafetyPushDailyCap, FRONTIER_SAFETY_PUSH_DAILY_CAP_DEFAULT);
  const notifier = (/** @type {Record<string, any>} */ config) => new FrontierNotifications({ database: {}, config }).safetyDailyCap;
  assert.equal(notifier({}), FRONTIER_SAFETY_PUSH_DAILY_CAP_DEFAULT);
  assert.equal(notifier({ frontierSafetyPushDailyCap: 5 }), 5);
  assert.equal(notifier({ frontierSafetyPushDailyCap: "x" }), 3);
  assert.equal(notifier({ frontierSafetyPushDailyCap: 0 }), 3, "a ceiling of none is not a setting: the lowest is one");
  assert.equal(notifier({ frontierSafetyPushDailyCap: 500 }), 50);
  const example = await readFile(path.join(repoRoot, "deploy/web/.env.example"), "utf8");
  const compose = await readFile(path.join(repoRoot, "deploy/web/docker-compose.yml"), "utf8");
  assert.equal([...example.matchAll(/^OPEN_SCIENCE_FRONTIER_SAFETY_PUSH_DAILY_CAP=(\d+)$/gm)].map((match) => Number(match[1])).join(), "3");
  assert.match(compose, /^\s+OPEN_SCIENCE_FRONTIER_SAFETY_PUSH_DAILY_CAP:\s*$/m);
});

test("the events route's per-reader minute has one default: the config's, the module's and the example .env agree; out of range stops the start", async () => {
  const { FRONTIER_EVENTS_PER_MINUTE_DEFAULT, FrontierInteractions } = await import("../src/frontierInteractions.mjs");
  const { readFile } = await import("node:fs/promises");
  assert.equal(configUnder({}).frontierEventsPerMinute, FRONTIER_EVENTS_PER_MINUTE_DEFAULT);
  assert.equal(configUnder({ OPEN_SCIENCE_FRONTIER_EVENTS_PER_MINUTE: "120" }).frontierEventsPerMinute, 120);
  assert.equal(configUnder({ OPEN_SCIENCE_FRONTIER_EVENTS_PER_MINUTE: "" }).frontierEventsPerMinute, FRONTIER_EVENTS_PER_MINUTE_DEFAULT, "empty is unset");
  for (const value of ["0", "9", "10001", "1.5", "many"]) assert.throws(() => configUnder({ OPEN_SCIENCE_FRONTIER_EVENTS_PER_MINUTE: value }), /OPEN_SCIENCE_FRONTIER_EVENTS_PER_MINUTE/);
  assert.equal(new FrontierInteractions({ database: {} }).perMinute, FRONTIER_EVENTS_PER_MINUTE_DEFAULT);
  const example = await readFile(path.join(repoRoot, "deploy/web/.env.example"), "utf8");
  const compose = await readFile(path.join(repoRoot, "deploy/web/docker-compose.yml"), "utf8");
  assert.equal([...example.matchAll(/^OPEN_SCIENCE_FRONTIER_EVENTS_PER_MINUTE=(\d+)$/gm)].map((match) => Number(match[1])).join(), String(FRONTIER_EVENTS_PER_MINUTE_DEFAULT));
  assert.match(compose, /^\s+OPEN_SCIENCE_FRONTIER_EVENTS_PER_MINUTE:\s*$/m);
});

test("every lever is read from the environment, and an empty value reads as unset", () => {
  const config = configUnder({
    OPEN_SCIENCE_FRONTIER_ENABLED: "true", OPEN_SCIENCE_FRONTIER_AUDIENCE: "operators", OPEN_SCIENCE_FRONTIER_PREVIEW_USERS: "acceptance, qa",
    OPEN_SCIENCE_FRONTIER_POLL_MS: "2000", OPEN_SCIENCE_FRONTIER_LEASE_MS: "", OPEN_SCIENCE_FRONTIER_MODEL: "deepseek-v4-flash",
    OPEN_SCIENCE_FRONTIER_DAILY_TIME: "08:05", OPEN_SCIENCE_FRONTIER_TIMEZONE: "UTC", OPEN_SCIENCE_FRONTIER_DAILY_BUDGET_CNY: "0",
    OPEN_SCIENCE_FRONTIER_PROCESS_CONCURRENCY: "4", OPEN_SCIENCE_FRONTIER_OFFPEAK: "false", OPEN_SCIENCE_FRONTIER_SELECT_THRESHOLD: "65",
    OPEN_SCIENCE_FRONTIER_PREPRINT_LANE_PER_DAY: "3", OPEN_SCIENCE_FRONTIER_PREPRINT_LANE_MIN_SCORE: "", OPEN_SCIENCE_FRONTIER_SAFETY_PUSH_DAILY_CAP: "5",
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
  assert.equal(config.frontierPreprintLanePerDay, 3);
  assert.equal(config.frontierPreprintLaneMinScore, 50, "an empty value is the default, not 0");
  assert.equal(config.frontierSafetyPushDailyCap, 5);
  assert.equal(configUnder({ OPEN_SCIENCE_FRONTIER_PREPRINT_LANE_PER_DAY: "0" }).frontierPreprintLanePerDay, 0, "0 is no lane");
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
    ["OPEN_SCIENCE_FRONTIER_PREPRINT_LANE_PER_DAY", "11"],
    ["OPEN_SCIENCE_FRONTIER_PREPRINT_LANE_PER_DAY", "-1"],
    ["OPEN_SCIENCE_FRONTIER_PREPRINT_LANE_PER_DAY", "1.5"],
    ["OPEN_SCIENCE_FRONTIER_PREPRINT_LANE_MIN_SCORE", "101"],
    ["OPEN_SCIENCE_FRONTIER_PREPRINT_LANE_MIN_SCORE", "high"],
    ["OPEN_SCIENCE_FRONTIER_SAFETY_PUSH_DAILY_CAP", "0"],
    ["OPEN_SCIENCE_FRONTIER_SAFETY_PUSH_DAILY_CAP", "51"],
    ["OPEN_SCIENCE_FRONTIER_SAFETY_PUSH_DAILY_CAP", "2.5"],
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

test("notification and safety scans have bounded operator settings passed through deployment", async () => {
  const { readFile } = await import("node:fs/promises");
  const defaulted = configUnder({});
  assert.equal(defaulted.frontierNotifyBatch, 50);
  assert.equal(defaulted.frontierSafetyScanBatch, 100);
  const configured = configUnder({ OPEN_SCIENCE_FRONTIER_NOTIFY_BATCH: "17", OPEN_SCIENCE_FRONTIER_SAFETY_SCAN_BATCH: "123" });
  assert.equal(configured.frontierNotifyBatch, 17); assert.equal(configured.frontierSafetyScanBatch, 123);
  for (const [name, invalid] of [["OPEN_SCIENCE_FRONTIER_NOTIFY_BATCH", "201"], ["OPEN_SCIENCE_FRONTIER_SAFETY_SCAN_BATCH", "501"], ["OPEN_SCIENCE_FRONTIER_NOTIFY_BATCH", "1.5"], ["OPEN_SCIENCE_FRONTIER_SAFETY_SCAN_BATCH", "0"]]) {
    assert.throws(() => configUnder({ [name]: invalid }), new RegExp(name));
  }
  const example = await readFile(path.join(repoRoot, "deploy/web/.env.example"), "utf8");
  const compose = await readFile(path.join(repoRoot, "deploy/web/docker-compose.yml"), "utf8");
  for (const [name, value] of [["OPEN_SCIENCE_FRONTIER_NOTIFY_BATCH", 50], ["OPEN_SCIENCE_FRONTIER_SAFETY_SCAN_BATCH", 100]]) {
    assert.match(example, new RegExp(`^${name}=${value}$`, "m")); assert.match(compose, new RegExp(`^\\s+${name}:`, "m"));
  }
});

test("ct-mix: lead triggers are on with the module, 120 searches a day, one default in config, the module and the example .env", async () => {
  const { FRONTIER_LEADS_DAILY_QUERIES_DEFAULT, FrontierLeads } = await import("../src/frontierLeads.mjs");
  const { readFile } = await import("node:fs/promises");
  const config = configUnder({});
  assert.deepEqual([config.frontierLeadsEnabled, config.frontierLeadsDailyQueries], [true, FRONTIER_LEADS_DAILY_QUERIES_DEFAULT]);
  assert.equal(FRONTIER_LEADS_DAILY_QUERIES_DEFAULT, 120);
  assert.equal(new FrontierLeads({ database: {}, plugin: null, owner: () => null, config: {} }).dailyQueries, FRONTIER_LEADS_DAILY_QUERIES_DEFAULT);
  assert.equal(new FrontierLeads({ database: {}, plugin: null, owner: () => null, config: { frontierLeadsDailyQueries: 0 } }).dailyQueries, 0, "0 makes none");
  assert.equal(configUnder({ OPEN_SCIENCE_FRONTIER_LEADS_ENABLED: "false" }).frontierLeadsEnabled, false);
  assert.equal(configUnder({ OPEN_SCIENCE_FRONTIER_LEADS_DAILY_QUERIES: "40" }).frontierLeadsDailyQueries, 40);
  assert.throws(() => configUnder({ OPEN_SCIENCE_FRONTIER_LEADS_DAILY_QUERIES: "5000" }), /OPEN_SCIENCE_FRONTIER_LEADS_DAILY_QUERIES/);
  const example = await readFile(path.join(repoRoot, "deploy/web/.env.example"), "utf8");
  assert.deepEqual([...example.matchAll(/^OPEN_SCIENCE_FRONTIER_LEADS_DAILY_QUERIES=(\d+)$/gm)].map((match) => Number(match[1])), [FRONTIER_LEADS_DAILY_QUERIES_DEFAULT]);
  const compose = await readFile(path.join(repoRoot, "deploy/web/docker-compose.yml"), "utf8");
  for (const name of ["OPEN_SCIENCE_FRONTIER_LEADS_ENABLED", "OPEN_SCIENCE_FRONTIER_LEADS_DAILY_QUERIES"]) assert.match(compose, new RegExp(`\\n\\s+${name}:\\n`), name);
});

test("c3-faith: the study facts and the check are on with the module, each with its own lever in config, compose and the example .env", async () => {
  const { readFile } = await import("node:fs/promises");
  const config = configUnder({});
  assert.deepEqual([config.frontierStudyFactsEnabled, config.frontierFaithEnabled], [true, true]);
  assert.equal(configUnder({ OPEN_SCIENCE_FRONTIER_STUDY_FACTS_ENABLED: "false" }).frontierStudyFactsEnabled, false);
  assert.equal(configUnder({ OPEN_SCIENCE_FRONTIER_FAITH_ENABLED: "false" }).frontierFaithEnabled, false);
  const example = await readFile(path.join(repoRoot, "deploy/web/.env.example"), "utf8");
  for (const name of ["OPEN_SCIENCE_FRONTIER_STUDY_FACTS_ENABLED", "OPEN_SCIENCE_FRONTIER_FAITH_ENABLED"]) assert.match(example, new RegExp(`^${name}=true$`, "m"), name);
  const compose = await readFile(path.join(repoRoot, "deploy/web/docker-compose.yml"), "utf8");
  for (const name of ["OPEN_SCIENCE_FRONTIER_STUDY_FACTS_ENABLED", "OPEN_SCIENCE_FRONTIER_FAITH_ENABLED"]) assert.match(compose, new RegExp(`\\n\\s+${name}:\\n`), name);
  // A pipeline made without a config asks for no extra call.
  const { FrontierPipeline } = await import("../src/frontierPipeline.mjs");
  const bare = new FrontierPipeline({ database: {}, editor: { screen() {}, edit() {} }, plugin: { text() {} }, config: {} });
  assert.deepEqual([bare.studyFactsEnabled, bare.faithEnabled], [false, false]);
  const on = new FrontierPipeline({ database: {}, editor: { screen() {}, edit() {} }, plugin: { text() {} }, config });
  assert.deepEqual([on.studyFactsEnabled, on.faithEnabled], [true, true]);
  const factsOnly = new FrontierPipeline({ database: {}, editor: { screen() {}, edit() {} }, plugin: { text() {} }, config: { ...config, frontierFaithEnabled: false } });
  assert.deepEqual([factsOnly.studyFactsEnabled, factsOnly.faithEnabled], [true, false]);
  const off = new FrontierPipeline({ database: {}, editor: { screen() {}, edit() {} }, plugin: { text() {} }, config: { ...config, frontierStudyFactsEnabled: false } });
  assert.deepEqual([off.studyFactsEnabled, off.faithEnabled], [false, false], "the check needs the facts");
});
