// The frontier module's metric families as the alert rules read them: the plugin's model
// calls (plan §14.10, alert past 50 a day) reach a gauge, and every plugin family an alert
// names is one the module exports.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ALERT_NOTICES, alertNoticeText } from "../src/alertNotices.mjs";
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
});

test("D-12: no alert guards the plugin's model calls while the plugin has no model client; the gauge stays, and says it is reserved", async () => {
  // `model_calls_24h` is a constant 0 in the plugin (no LLM client under knowledge_plugin/: a drifted list page is recovered by
  // its vetted selector fallbacks), so a rule on it could never fire and read as a guard that did not exist.
  const rules = JSON.parse(await readFile(path.join(repoRoot, "deploy/web/monitoring/open-science.rules.json"), "utf8"));
  const alerts = rules.groups.flatMap((/** @type {any} */ group) => group.rules);
  assert.equal(alerts.some((/** @type {any} */ rule) => rule.alert === "FrontierPluginModelCallsHigh" || String(rule.expr).includes("plugin_model_calls_24h")), false);
  const runbook = await readFile(path.join(repoRoot, "docs/WEB_OPERATIONS_RUNBOOK.md"), "utf8");
  assert.doesNotMatch(runbook, /FrontierPluginModelCallsHigh/);
  // The gauge is kept so a dashboard that draws it does not break, and its help no longer describes a proposer that does not exist.
  const gauge = family(frontierMetricFamilies(true, snapshot({ ...HEALTH, modelCalls24h: 0 })), "open_science_frontier_plugin_model_calls_24h");
  assert.deepEqual(gauge?.series, [{ value: 0 }]);
  assert.match(gauge?.help ?? "", /reserved/);
  assert.match(gauge?.help ?? "", /always 0 until the plugin has a model client/);
  assert.doesNotMatch(gauge?.help ?? "", /self-heal proposals/);
});

test("D-14: the exit-outage alert covers every exit that serves sources and can go down unseen: the relay, the browser and the EviMed API", async () => {
  // An unavailable exit is a neutral outcome in the plugin (it reschedules the poll without a failure), so no source turns
  // unhealthy when Chromium is down: 23 browser sources and two safety feeds went silent under every health state `healthy`.
  const rules = JSON.parse(await readFile(path.join(repoRoot, "deploy/web/monitoring/open-science.rules.json"), "utf8"));
  const group = rules.groups.find((/** @type {any} */ entry) => entry.name === "evimed-frontier");
  const exitRules = group.rules.filter((/** @type {any} */ rule) => String(rule.expr).includes("open_science_frontier_plugin_egress_state"));
  assert.equal(exitRules.length, 1, "one rule over the exits");
  const [rule] = exitRules;
  assert.equal(rule.for, "30m");
  assert.equal(rule.labels.severity, "warning");
  // PromQL matchers are fully anchored: `=` is equality, `=~` a regular expression matching the whole value.
  const matcher = /egress(=~|=)"([^"]+)"/.exec(String(rule.expr).replace(/\\"/g, '"'));
  assert.ok(matcher, "the rule selects by exit");
  const selects = (/** @type {string} */ exit) => (matcher[1] === "=" ? matcher[2] === exit : new RegExp(`^(?:${matcher[2]})$`).test(exit));
  assert.match(String(rule.expr), /state="down"\} == 1$/);
  const view = snapshot({ ...HEALTH, egress: { direct: "ok", api: "ok", relay: "down", browser: "down", bridge: "unconfigured", "evimed-api": "down" } });
  const down = family(frontierMetricFamilies(true, view), "open_science_frontier_plugin_egress_state").series
    .filter((/** @type {any} */ row) => row.labels.state === "down" && row.value === 1).map((/** @type {any} */ row) => row.labels.egress).sort();
  assert.deepEqual(down, ["browser", "evimed-api", "relay"]);
  for (const exit of down) assert.ok(selects(exit), `${exit} is covered`);
  for (const exit of ["direct", "api", "bridge"]) assert.ok(!selects(exit), `${exit} is not this rule's`);
  // The alert names its exit, in the rule and in the operator's inbox.
  assert.match(rule.annotations.description, /\{\{ \$labels\.egress \}\}/);
  assert.match(ALERT_NOTICES[rule.alert].sentence, /\{egress\}/);
  assert.match(alertNoticeText({ alertname: rule.alert, summary: "", description: "", labels: { egress: "browser" } }).sentence, /经 browser 出口/);
  const runbook = await readFile(path.join(repoRoot, "docs/WEB_OPERATIONS_RUNBOOK.md"), "utf8");
  assert.ok(runbook.includes(`\`${rule.alert}\``), "the runbook has a row for it");
  for (const exit of ["relay", "browser", "evimed-api"]) assert.match(runbook.slice(runbook.indexOf(`\`${rule.alert}\``)).split("\n")[0], new RegExp(`\`${exit}\``), `the row names the ${exit} exit`);
});

test("weekly and notification metrics distinguish unavailable delivery and scan gaps", () => {
  const view = snapshot(null);
  view.composer = { weekly: { available: true, counters: { issues: 2, empty: 1, failures: 0 } }, notifications: { available: false, counters: { queued: 3, delivered: 1, skipped: 1, failed: 1, scanGaps: 2 } } };
  const families = frontierMetricFamilies(true, view);
  assert.deepEqual(family(families, "open_science_frontier_notifications_available").series, [{ value: 0 }]);
  assert.ok(family(families, "open_science_frontier_notifications_total").series.some(row => row.labels.outcome === "scanGaps" && row.value === 2));
});

test("D-02: the jobs put back after giving up, and the attempts given back, are counted for the daily, the weekly and the notices", () => {
  const view = snapshot(null);
  view.composer = {
    daily: { missing: false, counters: { issues: 1, empty: 0, failures: 3, rearmed: 2, aiMinutes: 1, aiMinuteDropped: 0, pushed: 0, pushFailures: 0 } },
    weekly: { available: true, counters: { issues: 1, empty: 0, failures: 3, rearmed: 1 } },
    notifications: { available: true, counters: { queued: 1, delivered: 0, skipped: 0, failed: 3, refunded: 2, rearmed: 4, scanGaps: 0 } },
  };
  const families = frontierMetricFamilies(true, view);
  const outcome = (name, label) => family(families, name).series.find((row) => row.labels.outcome === label)?.value;
  assert.equal(outcome("open_science_frontier_daily_total", "rearmed"), 2);
  assert.equal(outcome("open_science_frontier_weekly_total", "rearmed"), 1);
  assert.equal(outcome("open_science_frontier_notifications_total", "rearmed"), 4);
  assert.equal(outcome("open_science_frontier_notifications_total", "refunded"), 2);
});

test("D-03: a cursor rewound because the plugin's numbering went back is a counter, and the flag shows as the last error", () => {
  const view = snapshot(null);
  view.plugin.rewinds = { count: 2, from: 2000, to: 0, at: "2026-10-10T03:00:00Z" };
  view.plugin.lastError = "knowledge_plugin_cursor_ahead";
  const families = frontierMetricFamilies(true, view);
  assert.deepEqual(family(families, "open_science_frontier_cursor_rewinds_total")?.series, [{ value: 2 }]);
  assert.equal(family(families, "open_science_frontier_cursor_rewinds_total")?.type, "counter");
  assert.deepEqual(family(families, "open_science_frontier_pull_last_error")?.series, [{ labels: { code: "knowledge_plugin_cursor_ahead" }, value: 1 }]);
  assert.deepEqual(family(frontierMetricFamilies(true, snapshot(null)), "open_science_frontier_cursor_rewinds_total")?.series, [{ value: 0 }], "a plugin that never went back has counted none");
});

test("D-17: the stream pages asked for again with half the limit are a counter", () => {
  const view = snapshot(null);
  view.plugin.counters.pageShrinks = 3;
  assert.deepEqual(family(frontierMetricFamilies(true, view), "open_science_frontier_page_shrinks_total")?.series, [{ value: 3 }]);
  assert.equal(family(frontierMetricFamilies(true, view), "open_science_frontier_page_shrinks_total")?.type, "counter");
  assert.deepEqual(family(frontierMetricFamilies(true, snapshot(null)), "open_science_frontier_page_shrinks_total")?.series, [{ value: 0 }]);
});

test("D-16: the items left unplaced because the model could not be asked are a counter among the events", () => {
  const view = snapshot(null);
  view.composer = { events: { counters: { clustered: 4, deferred: 3 } } };
  const kinds = Object.fromEntries(family(frontierMetricFamilies(true, view), "open_science_frontier_events_total").series.map((row) => [row.labels.kind, row.value]));
  assert.equal(kinds.deferred, 3);
  assert.equal(kinds.clustered, 4);
});

test("the edit failures are exported by kind as well as by field, and the trimmed summaries are counted", () => {
  const view = snapshot(null);
  view.editor = { counters: {
    editCalls: 9, rewrites: 4, numberCheck: { first: 9, firstFailed: 1 },
    firstPassFailures: { summary_zh: 4, title_zh: 1 },
    firstPassIssues: { summary_zh: { length: 3, number: 1 }, title_zh: { link: 1 } },
    finalIssues: { summary_zh: { length: 1 } },
    summaryTrimmed: 2,
  } };
  const families = frontierMetricFamilies(true, view);
  assert.deepEqual(family(families, "open_science_frontier_edit_first_pass_issues_total")?.series, [
    { labels: { field: "summary_zh", kind: "length" }, value: 3 },
    { labels: { field: "summary_zh", kind: "number" }, value: 1 },
    { labels: { field: "title_zh", kind: "link" }, value: 1 },
  ]);
  assert.deepEqual(family(families, "open_science_frontier_edit_final_issues_total")?.series,
    [{ labels: { field: "summary_zh", kind: "length" }, value: 1 }]);
  assert.deepEqual(family(families, "open_science_frontier_edit_summary_trimmed_total")?.series, [{ value: 2 }]);
  assert.equal(family(families, "open_science_frontier_edit_summary_trimmed_total")?.type, "counter");
  assert.deepEqual(family(families, "open_science_frontier_edit_first_pass_failures_total")?.series.length, 2, "the field counter stays");
  // A fresh process has counted nothing: the families exist with no series, as the field counter's does.
  const fresh = frontierMetricFamilies(true, { ...snapshot(null), editor: { counters: { editCalls: 0, rewrites: 0, firstPassFailures: {}, firstPassIssues: {}, finalIssues: {}, summaryTrimmed: 0 } } });
  assert.deepEqual(family(fresh, "open_science_frontier_edit_first_pass_issues_total")?.series, []);
  assert.deepEqual(family(fresh, "open_science_frontier_edit_summary_trimmed_total")?.series, [{ value: 0 }]);
});
