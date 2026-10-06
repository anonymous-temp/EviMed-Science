// The levers of keeping evidence current (evidence-flywheel F13, F14, 2026-10-05): the defaults, every value outside its range refused at start
// by the variable's name, every lever carried by .env.example and handed to the web service by compose, the api-only shape keeping the switch
// off, and the operator metrics saying whether the switch is on.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";
import { createEvidenceChangeLog, evidenceChangeLogMetricFamilies } from "../src/evidenceChangeLog.mjs";
import { createEvidenceChallenges, evidenceChallengeMetricFamilies } from "../src/evidenceChallenges.mjs";
import { EVIDENCE_UPKEEP_DEFAULTS, createEvidenceUpkeep, evidenceUpkeepMetricFamilies } from "../src/evidenceCurrency.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const LEVERS = [
  ["OPEN_SCIENCE_EVIDENCE_UPKEEP_ENABLED", "evidenceUpkeepEnabled", false],
  ["OPEN_SCIENCE_EVIDENCE_UPKEEP_BATCH", "evidenceUpkeepBatch", 20],
  ["OPEN_SCIENCE_EVIDENCE_UPKEEP_INTERVAL_HOURS", "evidenceUpkeepIntervalHours", 24],
  ["OPEN_SCIENCE_EVIDENCE_CHALLENGES_PER_DAY", "evidenceChallengesPerDay", 10],
  ["OPEN_SCIENCE_EVIDENCE_RETIRE_AFTER_CHECKS", "evidenceRetireAfterChecks", 6],
  ["OPEN_SCIENCE_EVIDENCE_RETIRE_AFTER_DAYS", "evidenceRetireAfterDays", 180],
  ["OPEN_SCIENCE_EVIDENCE_VERIFY_READS_PER_DAY", "evidenceVerifyReadsPerDay", 60],
];

/** loadConfig under exactly `env`. @param {Record<string, string>} env */
function configUnder(env) {
  const saved = process.env;
  process.env = { ...env };
  try { return /** @type {Record<string, any>} */ (loadConfig({ rootDir: repoRoot })); } finally { process.env = saved; }
}

test("the defaults are off, a batch of twenty a day, ten challenges a reader, six quiet checks over half a year — and the module's own defaults agree", () => {
  const config = configUnder({});
  for (const [, key, expected] of LEVERS) assert.equal(config[key], expected, key);
  assert.deepEqual(
    [config.evidenceUpkeepBatch, config.evidenceUpkeepIntervalHours, config.evidenceChallengesPerDay, config.evidenceRetireAfterChecks, config.evidenceRetireAfterDays],
    [EVIDENCE_UPKEEP_DEFAULTS.batch, EVIDENCE_UPKEEP_DEFAULTS.intervalHours, EVIDENCE_UPKEEP_DEFAULTS.challengesPerDay, EVIDENCE_UPKEEP_DEFAULTS.retireAfterChecks, EVIDENCE_UPKEEP_DEFAULTS.retireAfterDays],
    "the loops fall back to the numbers config.mjs does");
});

test("every lever is read from the environment, and an empty value reads as unset", () => {
  const config = configUnder({
    OPEN_SCIENCE_EVIDENCE_UPKEEP_ENABLED: "true", OPEN_SCIENCE_EVIDENCE_UPKEEP_BATCH: "5", OPEN_SCIENCE_EVIDENCE_UPKEEP_INTERVAL_HOURS: "6",
    OPEN_SCIENCE_EVIDENCE_CHALLENGES_PER_DAY: "3", OPEN_SCIENCE_EVIDENCE_RETIRE_AFTER_CHECKS: "4", OPEN_SCIENCE_EVIDENCE_RETIRE_AFTER_DAYS: "30",
  });
  assert.deepEqual([config.evidenceUpkeepEnabled, config.evidenceUpkeepBatch, config.evidenceUpkeepIntervalHours, config.evidenceChallengesPerDay, config.evidenceRetireAfterChecks, config.evidenceRetireAfterDays],
    [true, 5, 6, 3, 4, 30]);
  const empty = configUnder({ OPEN_SCIENCE_EVIDENCE_UPKEEP_BATCH: "", OPEN_SCIENCE_EVIDENCE_CHALLENGES_PER_DAY: "", OPEN_SCIENCE_EVIDENCE_UPKEEP_ENABLED: "" });
  assert.deepEqual([empty.evidenceUpkeepBatch, empty.evidenceChallengesPerDay, empty.evidenceUpkeepEnabled], [20, 10, false], "an empty value is the default, not 0");
});

test("a value outside its range stops the start by the variable's name", () => {
  for (const [name, value] of [
    ["OPEN_SCIENCE_EVIDENCE_UPKEEP_BATCH", "0"], ["OPEN_SCIENCE_EVIDENCE_UPKEEP_BATCH", "201"], ["OPEN_SCIENCE_EVIDENCE_UPKEEP_BATCH", "1.5"],
    ["OPEN_SCIENCE_EVIDENCE_UPKEEP_INTERVAL_HOURS", "0"], ["OPEN_SCIENCE_EVIDENCE_UPKEEP_INTERVAL_HOURS", "721"],
    ["OPEN_SCIENCE_EVIDENCE_CHALLENGES_PER_DAY", "0"], ["OPEN_SCIENCE_EVIDENCE_CHALLENGES_PER_DAY", "many"],
    ["OPEN_SCIENCE_EVIDENCE_RETIRE_AFTER_CHECKS", "1"], ["OPEN_SCIENCE_EVIDENCE_RETIRE_AFTER_DAYS", "6"], ["OPEN_SCIENCE_EVIDENCE_RETIRE_AFTER_DAYS", "3651"],
    ["OPEN_SCIENCE_EVIDENCE_VERIFY_READS_PER_DAY", "0"], ["OPEN_SCIENCE_EVIDENCE_VERIFY_READS_PER_DAY", "1001"],
  ]) assert.throws(() => configUnder({ [name]: value }), new RegExp(name), `${name}=${value}`);
});

test("each lever is documented in .env.example at the code's default and handed to the web service by compose", async () => {
  const example = await readFile(path.join(repoRoot, "deploy/web/.env.example"), "utf8");
  const compose = await readFile(path.join(repoRoot, "deploy/web/docker-compose.yml"), "utf8");
  const defaults = configUnder({});
  for (const [name, key] of LEVERS) {
    const lines = [...example.matchAll(new RegExp(`^${name}=(.*)$`, "gm"))];
    assert.equal(lines.length, 1, `${name} appears once in .env.example`);
    assert.equal(String(lines[0][1]), String(defaults[key]), `${name} in .env.example is the code's default`);
    assert.match(compose, new RegExp(`^\\s+${name}:\\s*$`, "m"), `${name} is passed by compose, value-less so an unset lever keeps the code's default`);
  }
});

test("the api-only shape keeps the switch off even from a .env copied from a full deployment", async () => {
  const apiOnly = await readFile(path.join(repoRoot, "deploy/web/docker-compose.api-only.yml"), "utf8");
  assert.match(apiOnly, /OPEN_SCIENCE_EVIDENCE_UPKEEP_ENABLED: \$\{OPEN_SCIENCE_EVIDENCE_UPKEEP_ENABLED:-false\}/);
});

test("the operator metrics say whether the switch is on, and export no loop counter while the module is not composed", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { createWebApiApp } = await import("../src/server.mjs");
  /** @param {Record<string, any>} overrides */
  async function scrape(overrides) {
    const dataDir = await mkdtemp(path.join(tmpdir(), "os-evidence-upkeep-metrics-"));
    const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: true, operatorMetricsToken: "test-only-metrics-token", ...overrides });
    const address = await app.listen(0, "127.0.0.1");
    try { return await (await fetch(`http://127.0.0.1:${address.port}/api/ops/metrics`, { headers: { authorization: "Bearer test-only-metrics-token" } })).text(); }
    finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
  }
  assert.match(await scrape({}), /^open_science_evidence_upkeep_enabled 0$/m);
  const on = await scrape({ evidenceUpkeepEnabled: true });
  assert.match(on, /^open_science_evidence_upkeep_enabled 1$/m);
  assert.doesNotMatch(on, /open_science_evidence_upkeep_cards_checked_total/, "without the frontier and a database nothing of it is composed, so nothing of it is counted");
});

test("every loop's counter is exported as a metric family, labelled, and nothing is exported for a module that was not composed", () => {
  const database = /** @type {any} */ ({});
  const changeLog = createEvidenceChangeLog({ database });
  const names = [
    ...evidenceUpkeepMetricFamilies(createEvidenceUpkeep({ database, changeLog }).stats()),
    ...evidenceChallengeMetricFamilies(createEvidenceChallenges({ database, service: {}, changeLog }).stats()),
    ...evidenceChangeLogMetricFamilies(changeLog.stats()),
  ].map((family) => family.name);
  assert.deepEqual(names.sort(), [
    "open_science_evidence_challenge_rechecks_total", "open_science_evidence_challenges_total", "open_science_evidence_change_log_entries_total",
    "open_science_evidence_upkeep_answers_total", "open_science_evidence_upkeep_cards_checked_total", "open_science_evidence_upkeep_downstream_total",
    "open_science_evidence_upkeep_labelled_total", "open_science_evidence_upkeep_source_feed_total",
  ]);
  assert.deepEqual([evidenceUpkeepMetricFamilies(null), evidenceChallengeMetricFamilies(undefined), evidenceChangeLogMetricFamilies(null)], [[], [], []]);
  const logged = evidenceChangeLogMetricFamilies(changeLog.stats())[0].series.map((entry) => entry.labels?.category);
  assert.deepEqual(logged, ["searched_no_change", "new_evidence_conclusion_changed", "new_evidence_conclusion_unchanged", "correction", "withdrawal", "retired"], "one series per category of the closed list");
});
