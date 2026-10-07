// The evidence programme's levers (evidence-flywheel B7, 2026-10-05): the defaults the plan names, every value outside its range
// refused at start by the variable's name, and every lever carried by .env.example and the compose file that hands it to the process.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const LEVERS = [
  ["OPEN_SCIENCE_EVIDENCE_PROGRAMME_ENABLED", "evidenceProgrammeEnabled", false],
  ["OPEN_SCIENCE_EVIDENCE_PROGRAMME_DAILY_BUDGET_CNY", "evidenceProgrammeDailyBudgetCny", 30],
  ["OPEN_SCIENCE_EVIDENCE_PROGRAMME_MAX_CONCURRENCY", "evidenceProgrammeMaxConcurrency", 1],
  ["OPEN_SCIENCE_EVIDENCE_PROGRAMME_EPISODE_BUDGET_CNY", "evidenceProgrammeEpisodeBudgetCny", 10],
  ["OPEN_SCIENCE_EVIDENCE_PROGRAMME_MIN_DEMAND_USERS", "evidenceProgrammeMinDemandUsers", 5],
  ["OPEN_SCIENCE_EVIDENCE_PROGRAMME_ORIGINAL_ANALYSES_PER_WEEK", "evidenceProgrammeOriginalPerWeek", 2],
  ["OPEN_SCIENCE_EVIDENCE_PROGRAMME_STALE_CARD_DAYS", "evidenceProgrammeStaleCardDays", 30],
  ["OPEN_SCIENCE_EVIDENCE_PUBLIC_WEB_ENABLED", "evidencePublicWebEnabled", false],
  ["OPEN_SCIENCE_EVIDENCE_PUBLIC_INDEXABLE", "evidencePublicIndexable", false],
  ["OPEN_SCIENCE_EVIDENCE_PUBLIC_BASE_PATH", "evidencePublicBasePath", "/evidence"],
  ["OPEN_SCIENCE_EVIDENCE_PUBLIC_RATE_PER_MINUTE", "evidencePublicRatePerMinute", 120],
  ["OPEN_SCIENCE_EVIDENCE_TOPIC_REQUESTS_PER_DAY", "evidenceTopicRequestsPerDay", 5],
];

/** loadConfig under exactly `env`. @param {Record<string, string>} env */
function configUnder(env) {
  const saved = process.env;
  process.env = { ...env };
  try { return loadConfig({ rootDir: repoRoot }); } finally { process.env = saved; }
}

test("the defaults are the plan's: everything off, 30 yuan a day, one slot — and indexing is its own lever, off", () => {
  const config = /** @type {Record<string, any>} */ (configUnder({}));
  for (const [, key, expected] of LEVERS) assert.equal(config[key], expected, key);
});

test("every lever is read from the environment, and an empty value reads as unset", () => {
  const config = /** @type {Record<string, any>} */ (configUnder({
    OPEN_SCIENCE_EVIDENCE_PROGRAMME_ENABLED: "true", OPEN_SCIENCE_EVIDENCE_PROGRAMME_DAILY_BUDGET_CNY: "12.5", OPEN_SCIENCE_EVIDENCE_PROGRAMME_MAX_CONCURRENCY: "2",
    OPEN_SCIENCE_EVIDENCE_PUBLIC_WEB_ENABLED: "true", OPEN_SCIENCE_EVIDENCE_PUBLIC_INDEXABLE: "true",
  }));
  assert.deepEqual([config.evidenceProgrammeEnabled, config.evidenceProgrammeDailyBudgetCny, config.evidenceProgrammeMaxConcurrency, config.evidencePublicWebEnabled, config.evidencePublicIndexable],
    [true, 12.5, 2, true, true]);
  const empty = /** @type {Record<string, any>} */ (configUnder({ OPEN_SCIENCE_EVIDENCE_PROGRAMME_DAILY_BUDGET_CNY: "", OPEN_SCIENCE_EVIDENCE_PROGRAMME_MAX_CONCURRENCY: "", OPEN_SCIENCE_EVIDENCE_PROGRAMME_ENABLED: "" }));
  assert.deepEqual([empty.evidenceProgrammeDailyBudgetCny, empty.evidenceProgrammeMaxConcurrency, empty.evidenceProgrammeEnabled], [30, 1, false], "an empty value is the default, not 0");
  assert.equal(/** @type {any} */ (configUnder({ OPEN_SCIENCE_EVIDENCE_PROGRAMME_DAILY_BUDGET_CNY: "0" })).evidenceProgrammeDailyBudgetCny, 0, "0 is no cap, as every spend limit here reads 0");
  assert.equal(/** @type {any} */ (configUnder({ OPEN_SCIENCE_EVIDENCE_PROGRAMME_ENABLED: "false", OPEN_SCIENCE_EVIDENCE_PUBLIC_WEB_ENABLED: "off" })).evidenceProgrammeEnabled, false);
});

test("the programme's own limits are read, and the demand floor can be raised but never lowered below five readers", () => {
  const config = /** @type {Record<string, any>} */ (configUnder({
    OPEN_SCIENCE_EVIDENCE_PROGRAMME_EPISODE_BUDGET_CNY: "6.5", OPEN_SCIENCE_EVIDENCE_PROGRAMME_MIN_DEMAND_USERS: "12",
    OPEN_SCIENCE_EVIDENCE_PROGRAMME_ORIGINAL_ANALYSES_PER_WEEK: "0", OPEN_SCIENCE_EVIDENCE_PROGRAMME_STALE_CARD_DAYS: "45",
  }));
  assert.deepEqual([config.evidenceProgrammeEpisodeBudgetCny, config.evidenceProgrammeMinDemandUsers, config.evidenceProgrammeOriginalPerWeek, config.evidenceProgrammeStaleCardDays],
    [6.5, 12, 0, 45], "0 original analyses a week is a valid choice: none is published");
  for (const [name, value] of [
    ["OPEN_SCIENCE_EVIDENCE_PROGRAMME_MIN_DEMAND_USERS", "4"],
    ["OPEN_SCIENCE_EVIDENCE_PROGRAMME_MIN_DEMAND_USERS", "1"],
    ["OPEN_SCIENCE_EVIDENCE_PROGRAMME_MIN_DEMAND_USERS", "5.5"],
    ["OPEN_SCIENCE_EVIDENCE_PROGRAMME_ORIGINAL_ANALYSES_PER_WEEK", "-1"],
    ["OPEN_SCIENCE_EVIDENCE_PROGRAMME_ORIGINAL_ANALYSES_PER_WEEK", "15"],
    ["OPEN_SCIENCE_EVIDENCE_PROGRAMME_STALE_CARD_DAYS", "0"],
    ["OPEN_SCIENCE_EVIDENCE_PROGRAMME_STALE_CARD_DAYS", "366"],
    ["OPEN_SCIENCE_EVIDENCE_PROGRAMME_EPISODE_BUDGET_CNY", "1"],
    ["OPEN_SCIENCE_EVIDENCE_PROGRAMME_EPISODE_BUDGET_CNY", "lots"],
  ]) assert.throws(() => configUnder({ [name]: value }), new RegExp(name), `${name}=${value}`);
});

test("a value outside its range stops the start by the variable's name", () => {
  for (const [name, value] of [
    ["OPEN_SCIENCE_EVIDENCE_PROGRAMME_DAILY_BUDGET_CNY", "-1"],
    ["OPEN_SCIENCE_EVIDENCE_PROGRAMME_DAILY_BUDGET_CNY", "lots"],
    ["OPEN_SCIENCE_EVIDENCE_PROGRAMME_DAILY_BUDGET_CNY", "10001"],
    ["OPEN_SCIENCE_EVIDENCE_PROGRAMME_MAX_CONCURRENCY", "0"],
    ["OPEN_SCIENCE_EVIDENCE_PROGRAMME_MAX_CONCURRENCY", "1.5"],
    ["OPEN_SCIENCE_EVIDENCE_PROGRAMME_MAX_CONCURRENCY", "5"],
  ]) assert.throws(() => configUnder({ [name]: value }), new RegExp(name), `${name}=${value}`);
});

test("each lever is documented in .env.example at the code's default and handed to the web service by compose", async () => {
  const example = await readFile(path.join(repoRoot, "deploy/web/.env.example"), "utf8");
  const compose = await readFile(path.join(repoRoot, "deploy/web/docker-compose.yml"), "utf8");
  const defaults = /** @type {Record<string, any>} */ (configUnder({}));
  for (const [name, key] of LEVERS) {
    const lines = [...example.matchAll(new RegExp(`^${name}=(.*)$`, "gm"))];
    assert.equal(lines.length, 1, `${name} appears once in .env.example`);
    assert.equal(String(lines[0][1]), String(defaults[key]), `${name} in .env.example is the code's default`);
    assert.match(compose, new RegExp(`^\\s+${name}:\\s*$`, "m"), `${name} is passed by compose, value-less so an unset lever keeps the code's default`);
  }
});

test("the api-only shape keeps the programme and the public pages off even from a .env copied from a full deployment", async () => {
  const apiOnly = await readFile(path.join(repoRoot, "deploy/web/docker-compose.api-only.yml"), "utf8");
  for (const name of ["OPEN_SCIENCE_EVIDENCE_PROGRAMME_ENABLED", "OPEN_SCIENCE_EVIDENCE_PUBLIC_WEB_ENABLED"]) {
    assert.match(apiOnly, new RegExp(`${name}: \\$\\{${name}:-false\\}`), name);
  }
});

test("the operator metrics say what the programme levers are, with the programme off and on", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { createWebApiApp } = await import("../src/server.mjs");
  /** @param {Record<string, any>} overrides */
  async function scrape(overrides) {
    const dataDir = await mkdtemp(path.join(tmpdir(), "os-evidence-metrics-"));
    const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: true, operatorMetricsToken: "test-only-metrics-token", ...overrides });
    const address = await app.listen(0, "127.0.0.1");
    try { return await (await fetch(`http://127.0.0.1:${address.port}/api/ops/metrics`, { headers: { authorization: "Bearer test-only-metrics-token" } })).text(); }
    finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
  }
  const off = await scrape({});
  assert.match(off, /^open_science_evidence_programme_enabled 0$/m);
  assert.match(off, /^open_science_evidence_public_web_enabled 0$/m);
  assert.match(off, /^open_science_evidence_public_indexable 0$/m);
  assert.doesNotMatch(off, /open_science_evidence_programme_budget/, "a programme that is off exports no budget series");
  const on = await scrape({ evidenceProgrammeEnabled: true, evidenceProgrammeDailyBudgetCny: 12, evidenceProgrammeMaxConcurrency: 2, evidencePublicWebEnabled: true });
  assert.match(on, /^open_science_evidence_programme_enabled 1$/m);
  assert.match(on, /^open_science_evidence_programme_budget_limit_cny 12$/m);
  assert.match(on, /^open_science_evidence_programme_concurrency_limit 2$/m);
  assert.match(on, /^open_science_evidence_public_web_enabled 1$/m);
  assert.match(on, /^open_science_evidence_public_indexable 0$/m, "indexing is its own lever");
  assert.match(on, /^open_science_evidence_programme_budget_state\{state="unavailable"\} 1$/m, "no ledger in this shape, so the spend is unmeasured, never zero");
});
