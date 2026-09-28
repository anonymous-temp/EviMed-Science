// The frontier module's metric families as the alert rules read them: the plugin's model
// calls (plan §14.10, alert past 50 a day) reach a gauge, and every plugin family an alert
// names is one the module exports.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { frontierMetricFamilies } from "../src/frontierService.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** A snapshot as frontierMetricsSnapshot builds it, with the plugin's health detail given. @param {any} detail */
function snapshot(detail) {
  return {
    tables: null, composer: null, actions: null, editor: null,
    budget: { spentCny: 0.5, budgetCny: 10, state: "ok" },
    worker: { pipeline: {}, loops: {} },
    client: { counters: { requests: 3, retries: 0, failures: 0 } },
    service: { lists: 0, notModified: 0, cacheHits: 0, invalidCursors: 0, searches: 0, searchFailures: 0 },
    plugin: {
      state: "ok", contract: "1.2.0", compatibility: "compatible", lastError: null, cursor: 10, latestSeq: 12, lag: 2,
      lastPullOkAt: "2026-09-28T03:00:00Z", lastMirrorAt: null, gaps: { count: 0, entries: 0 }, unknownVocabulary: {},
      counters: { pulls: 4, pullFailures: 0, inserted: 2, duplicates: 0, dropped: 0, invalid: 0, placeholders: 0 },
      pluginHealthDetail: detail,
    },
  };
}

const HEALTH = { egress: { direct: "ok", relay: "ok" }, backlog: { due_sources: 1, pending_texts: 254, oldest_due_s: 30 },
  lastOkFetchAt: "2026-09-28T03:00:00Z", lastNewEntryAt: "2026-09-28T02:00:00Z", rateLimited: { max: 0, host: null } };

/** @param {any[]} families @param {string} name */
const family = (families, name) => families.find((entry) => entry.name === name);

test("the plugin's model calls in the last 24 hours are a gauge, and a plugin that does not say has none", () => {
  const reported = frontierMetricFamilies(true, snapshot({ ...HEALTH, modelCalls24h: 51 }));
  assert.deepEqual(family(reported, "open_science_frontier_plugin_model_calls_24h")?.series, [{ value: 51 }]);
  assert.equal(family(reported, "open_science_frontier_plugin_model_calls_24h")?.type, "gauge");
  const zero = frontierMetricFamilies(true, snapshot({ ...HEALTH, modelCalls24h: 0 }));
  assert.deepEqual(family(zero, "open_science_frontier_plugin_model_calls_24h")?.series, [{ value: 0 }]);
  const silent = frontierMetricFamilies(true, snapshot({ ...HEALTH, modelCalls24h: null }));
  assert.equal(family(silent, "open_science_frontier_plugin_model_calls_24h"), undefined);
});

test("every open_science_frontier_plugin_* family an alert names is one the module exports", async () => {
  const rules = JSON.parse(await readFile(path.join(repoRoot, "deploy/web/monitoring/open-science.rules.json"), "utf8"));
  const group = rules.groups.find((/** @type {any} */ entry) => entry.name === "evimed-frontier");
  const named = new Set(group.rules.flatMap((/** @type {any} */ rule) => [...String(rule.expr).matchAll(/open_science_frontier_plugin_[a-z0-9_]+/g)]
    .map((match) => match[0])));
  assert.ok(named.size >= 4, `only ${named.size} plugin families were read from the rules; the scan is wrong`);
  const exported = new Set(frontierMetricFamilies(true, snapshot({ ...HEALTH, modelCalls24h: 0 })).map((entry) => entry.name));
  for (const name of named) assert.ok(exported.has(name), `${name} is alerted on but never exported`);
  const rule = group.rules.find((/** @type {any} */ entry) => entry.alert === "FrontierPluginModelCallsHigh");
  assert.equal(rule?.expr, "open_science_frontier_plugin_model_calls_24h > 50");
  assert.equal(rule?.labels?.severity, "warning");
});
