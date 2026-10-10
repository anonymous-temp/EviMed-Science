// A limit without an observable counter does not exist for the operator (principle 15). The module's
// limits are counted where they act and scraped from `/api/ops/metrics` (`evolutionOpsMetrics.mjs`).
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWebApiApp } from "../src/server.mjs";
import { createEvolutionVerificationController } from "../src/evolutionVerificationController.mjs";
import { createEvolutionToolAdmission } from "../src/evolutionToolAdmission.mjs";
import { createEvaluationIsolation } from "../src/evaluationIsolation.mjs";
import { createPlatformSkillSupply } from "../src/platformSkillSupply.mjs";
import { evolutionOpsMetricFamilies, evolutionOpsSnapshot } from "../src/evolutionOpsMetrics.mjs";
import { HttpError } from "../src/security.mjs";

const TOKEN = "evolution-metrics-token-0123456789abcdef";
const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}
const sample = (/** @type {any[]} */ families, /** @type {string} */ name, /** @type {Record<string, string>} */ labels = {}) => families.find((family) => family.name === name)
  ?.series.find((/** @type {any} */ row) => Object.entries(labels).every(([key, value]) => row.labels?.[key] === value))?.value;

test("with the module off the scrape says so, and says nothing else; refused says why", () => {
  assert.deepEqual(evolutionOpsMetricFamilies(false, null).map((family) => [family.name, family.series[0].value]), [["open_science_evolution_enabled", 0]]);
  const refused = evolutionOpsMetricFamilies(false, null, { code: "evolution_setting_invalid", key: "runtimeEgressAllowedPeers" });
  assert.equal(sample(refused, "open_science_evolution_refused", { code: "evolution_setting_invalid", key: "runtimeEgressAllowedPeers" }), 1);
  assert.equal(sample(refused, "open_science_evolution_enabled"), 0);
});

test("every limit's counter reaches the scrape under a closed set of outcomes", async () => {
  // The real counters of the real classes, driven until each question has refused once.
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "os-evolution-ops-"));
  try {
    let capacity = true;
    const admission = createEvolutionToolAdmission({ config: { evolutionToolMaxConcurrentPerProject: 1, evolutionToolCallsPerMinute: 2, evolutionDailyBudgetCny: 50 },
      database: { transaction: async (/** @type {any} */ run) => run({}) }, canRun: async () => true, heavyWorkAdmission: async () => capacity,
      isInternalProject: (/** @type {string} */ id) => id.startsWith("eval-paper-"), dailyCost: async () => 99 });
    await admission.admit({ project: { id: "p", userId: "u" } }, async () => "ok");
    capacity = false;
    await assert.rejects(admission.admit({ project: { id: "p", userId: "u" } }, async () => "x"), { code: "evolution_temporarily_unavailable" });
    capacity = true;
    await assert.rejects(admission.admit({ project: { id: "p", userId: "u" } }, async () => "x"), { code: "evolution_tool_rate_limited" });
    await assert.rejects(admission.admit({ project: { id: "eval-paper-x", userId: "u" } }, async () => "x"), { code: "usage_budget_exceeded" });

    const supply = createPlatformSkillSupply({ dataDir, evolutionEnabled: true }, { report: () => {} });
    supply.noteFailure("platform_skill_selection_failed");
    const isolation = createEvaluationIsolation({ dataDir, resolveRunId: async () => { throw new Error("ledger"); } });
    await isolation.filter({ userId: "op", projectId: "evimed-evolution" }, "web-search", { a: 1 });

    const executor = { ok: 4, candidateFailed: 1, unavailable: 2, timedOut: 3, canceled: 0, errored: 0, dependenciesPrepared: 1, dependencyPreparationFailed: 0 };
    const snapshot = await evolutionOpsSnapshot({ evolution: { toolAdmission: admission, supply, integration: { counters: { published: 5, failed: 1 } }, executorCounters: async () => executor }, evaluationIsolation: isolation });
    const families = evolutionOpsMetricFamilies(true, snapshot);
    for (const outcome of ["admitted", "refused_host_capacity", "refused_budget", "refused_project_rate"]) {
      assert.equal(sample(families, "open_science_evolution_tool_admission_total", { outcome }), 1, outcome);
    }
    assert.equal(sample(families, "open_science_evolution_tool_admission_total", { outcome: "refused_project_concurrency" }), 0);
    assert.equal(sample(families, "open_science_evolution_platform_skill_events_total", { event: "failed" }), 1);
    assert.equal(sample(families, "open_science_evolution_isolation_lookup_total", { outcome: "run_lookup_failed" }), 1);
    assert.equal(sample(families, "open_science_evolution_isolation_lookup_total", { outcome: "platform_lookup_failed" }), 0, "the store is readable here; the unreadable case is the isolation module's own test");
    // A development run whose model names the protected reference from memory is counted on a family of its own, once
    // however often the run is audited (a layer of its own here, so the lookup counts above stay what they were).
    assert.equal(sample(families, "open_science_evolution_reference_recalled_total"), 0);
    const recalling = createEvaluationIsolation({ dataDir });
    await recalling.register("run_recall", { aliases: ["10.1136/bmj.i6"], titles: [] });
    for (let audits = 0; audits < 2; audits++) await recalling.auditTranscript({ userId: "op", projectId: "eval-paper-build-x", runId: "run_recall" }, "builder-transcript",
      { served: { messages: [] }, own: [{ step: { message: 3, part: 0, voice: "reasoning" }, text: "from memory: doi:10.1136/bmj.i6" }] });
    assert.equal(sample(evolutionOpsMetricFamilies(true, await evolutionOpsSnapshot({ evolution: {}, evaluationIsolation: recalling })), "open_science_evolution_reference_recalled_total"), 1);
    assert.equal(sample(families, "open_science_evolution_events_total", { outcome: "published" }), 5);
    assert.equal(sample(families, "open_science_evolution_executor_reachable"), 1);
    assert.equal(sample(families, "open_science_evolution_executor_total", { outcome: "unavailable" }), 2);
    assert.equal(sample(families, "open_science_evolution_executor_total", { outcome: "timed_out" }), 3);
    // A controller that cannot answer costs the scrape its executor series, not the scrape.
    const unreachable = await evolutionOpsSnapshot({ evolution: { toolAdmission: admission, executorCounters: async () => { throw new Error("controller down"); } } });
    const degraded = evolutionOpsMetricFamilies(true, unreachable);
    assert.equal(sample(degraded, "open_science_evolution_executor_reachable"), 0);
    assert.equal(degraded.some((family) => family.name === "open_science_evolution_executor_total"), false);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("the candidate executor counts its slot refusals, timeouts, cancellations and candidate failures where they act", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "os-evolution-executor-count-"));
  try {
    /** @type {any} */
    let next = async () => "ok";
    const tools = { reconcileEvolutionAttempts: async () => {}, run: async () => next() };
    const executor = createEvolutionVerificationController({ dataDir, evolutionEnabled: true }, { tools, imageId: async () => "sha256:" + "a".repeat(64) });
    const call = () => executor.execute({ files: {}, code: "print(1)" });
    const unavailable = (/** @type {any} */ extra = {}) => Object.assign(new HttpError(503, "product_state_unavailable", "Isolated execution could not be confirmed."), extra);
    await call();
    next = async () => { throw Object.assign(new HttpError(400, "extension_contract_invalid", "x"), { joined: true, executionStarted: true }); };
    assert.equal((await call()).ok, false);
    for (const [error, expected] of [[unavailable(), "unavailable"], [unavailable({ canceled: false }), "timedOut"], [unavailable({ canceled: true }), "canceled"], [new Error("boom"), "errored"]]) {
      next = async () => { throw error; };
      await assert.rejects(call());
      assert.equal(executor.counters()[expected] >= 1, true, expected);
    }
    assert.deepEqual(executor.counters(), { ok: 1, candidateFailed: 1, unavailable: 1, timedOut: 1, canceled: 1, errored: 1, dependenciesPrepared: 0, dependencyPreparationFailed: 0 });
    await assert.rejects(executor.prepareDependencies({ requests: [{ id: "unlisted", version: "1", digest: "sha256:" + "b".repeat(64) }] }));
    assert.equal(executor.counters().dependencyPreparationFailed, 1);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("the real scrape carries the module's gauge off, and why it refused to start", async () => {
  for (const [label, environment, expected] of [
    ["off", {}, { enabled: 0, refused: false }],
    ["refused", { OPEN_SCIENCE_EVOLUTION_ENABLED: "true", OPEN_SCIENCE_EVOLUTION_DEPENDENCY_ALLOWLIST: "{not json" }, { enabled: 0, refused: true }],
  ]) {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "os-evolution-scrape-"));
    const prior = Object.fromEntries(Object.keys(environment).map((name) => [name, process.env[name]]));
    Object.assign(process.env, environment);
    const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: false, operatorMetricsToken: TOKEN });
    for (const [name, value] of Object.entries(prior)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    const address = await app.listen(0, "127.0.0.1");
    try {
      const text = await (await fetch(`http://127.0.0.1:${address.port}/api/ops/metrics`, { headers: { Authorization: `Bearer ${TOKEN}` } })).text();
      assert.match(text, new RegExp(`^open_science_evolution_enabled ${expected.enabled}$`, "m"), label);
      assert.equal(/^open_science_evolution_refused\{code="evolution_dependency_allowlist_invalid",key="evolutionDependencyAllowlist"\} 1$/m.test(text), expected.refused, label);
      assert.doesNotMatch(text, /open_science_evolution_tool_admission_total/, "no series for a module that is not running");
    } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
  }
});

test("a running module's scrape reads the executor from the controller's admission answer", {
  skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured",
}, async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "os-evolution-scrape-on-"));
  const operator = "operator_ops_metrics";
  const app = createWebApiApp({ dataDir, databaseUrl, stateStore: "postgres", requireSharedStateStore: true, runtimeMode: "mock", devAuth: false, authMode: "local",
    bootstrapUser: "", bootstrapPassword: "", deepseekProviderEnabled: false, researchMemoryEnabled: false, operatorUsers: [operator],
    evolutionEnabled: true, operatorMetricsToken: TOKEN,
    evolutionController: { evolutionAdmissionAvailable: async () => ({ available: true, executor: { ok: 7, candidateFailed: 0, unavailable: 2, timedOut: 1, canceled: 0, errored: 0, dependenciesPrepared: 0, dependencyPreparationFailed: 0 } }) } });
  const address = await app.listen(0, "127.0.0.1");
  try {
    assert.ok(app.evolution, "the module composes");
    const text = await (await fetch(`http://127.0.0.1:${address.port}/api/ops/metrics`, { headers: { Authorization: `Bearer ${TOKEN}` } })).text();
    assert.match(text, /^open_science_evolution_enabled 1$/m);
    assert.match(text, /^open_science_evolution_executor_reachable 1$/m);
    assert.match(text, /^open_science_evolution_executor_total\{outcome="unavailable"\} 2$/m);
    assert.match(text, /^open_science_evolution_executor_total\{outcome="timed_out"\} 1$/m);
    assert.match(text, /^open_science_evolution_tool_admission_total\{outcome="admitted"\} 0$/m);
    assert.match(text, /^open_science_evolution_platform_skill_events_total\{event="failed"\} 0$/m);
    assert.match(text, /^open_science_evolution_isolation_lookup_total\{outcome="refused"\} 0$/m);
    assert.match(text, /^open_science_evolution_reference_recalled_total 0$/m);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test("the loops' own limits reach the scrape: the account floors by class", async () => {
  const snapshot = await evolutionOpsSnapshot({ evolution: { limitCounters: () => ({ signals: { aggregated: { user: 2, operator: 1 }, heldBack: { user: 4, operator: 0 } } }) } });
  const families = evolutionOpsMetricFamilies(true, snapshot);
  assert.equal(sample(families, "open_science_evolution_signal_groups", { class: "user", outcome: "held_back" }), 4);
  assert.equal(sample(families, "open_science_evolution_signal_groups", { class: "operator", outcome: "aggregated" }), 1);
  assert.equal(families.find((family) => family.name === "open_science_evolution_signal_groups").series.length, 4);
  const reviews = evolutionOpsMetricFamilies(true, await evolutionOpsSnapshot({ evolution: { limitCounters: () => ({ engineReviews: { announced: 3, announceFailed: 1, adopted: 2, declined: 1 } }) } }));
  for (const [outcome, value] of [["announced", 3], ["announce_failed", 1], ["adopted", 2], ["declined", 1]]) assert.equal(sample(reviews, "open_science_evolution_engine_reviews_total", { outcome }), value, outcome);
  assert.equal(sample(evolutionOpsMetricFamilies(true, await evolutionOpsSnapshot({ evolution: { limitCounters: () => ({ policy: { ignoredFields: 5 } }) } })), "open_science_evolution_policy_ignored_fields_total"), 5);
  const window = evolutionOpsMetricFamilies(true, await evolutionOpsSnapshot({ evolution: { limitCounters: () => ({ heavyWindow: { open: false, started: { inside: 4, outside: 1 } } }) } }));
  assert.equal(sample(window, "open_science_evolution_heavy_window_open"), 0);
  assert.equal(sample(window, "open_science_evolution_heavy_jobs_started_total", { window: "inside" }), 4);
  assert.equal(sample(window, "open_science_evolution_heavy_jobs_started_total", { window: "outside" }), 1);
  const research = evolutionOpsMetricFamilies(true, await evolutionOpsSnapshot({ evolution: { limitCounters: () => ({ selfResearch: {
    collected: 40, merged: 31, alreadyScreened: 3, screened: 28, shortlisted: 9, fullTexts: 5, cards: 3, rejected: 1, venueEvents: 2,
    capHits: { collect: 0, screen: 1, shortlist: 2, fullText: 1, cards: 0 }, triageBatchesFailed: 1, extractFailed: 2, venueQuotesRejected: 4, sourcesRead: 20, sourcesSkipped: 4,
    fullTextFallbacks: { web_read_robots_disallowed: 3, not_arxiv: 2 }, enrichment: { semanticScholar: { no_key: 2 }, openAlex: { ok: 1, http_429: 1 } } } }) } }));
  for (const [stage, value] of [["collected", 40], ["merged", 31], ["already_screened", 3], ["screened", 28], ["shortlisted", 9], ["full_texts", 5], ["cards", 3], ["rejected", 1], ["venue_events", 2]]) {
    assert.equal(sample(research, "open_science_evolution_self_research_items_total", { stage }), value, stage);
  }
  assert.equal(sample(research, "open_science_evolution_self_research_cap_hits_total", { cap: "shortlist" }), 2);
  assert.equal(sample(research, "open_science_evolution_self_research_failures_total", { kind: "venue_quote" }), 4);
  assert.equal(sample(research, "open_science_evolution_self_research_failures_total", { kind: "triage_batch" }), 1);
  assert.equal(sample(research, "open_science_evolution_self_research_sources_total", { state: "skipped" }), 4);
  assert.equal(sample(research, "open_science_evolution_self_research_full_text_fallbacks_total", { reason: "web_read_robots_disallowed" }), 3);
  assert.equal(sample(research, "open_science_evolution_self_research_enrichment_total", { provider: "semanticScholar", outcome: "no_key" }), 2);
  assert.equal(sample(research, "open_science_evolution_self_research_enrichment_total", { provider: "openAlex", outcome: "http_429" }), 1);
  const requests = evolutionOpsMetricFamilies(true, await evolutionOpsSnapshot({ evolution: { limitCounters: () => ({ sourceRequests: { filed: 3, duplicate: 2, invalid: 1, unsupportedHost: 4, notAFeed: 5, unreachable: 6, capReached: 7, admitted: 8, lapsed: 9, waiting: 10 } }) } }));
  for (const [outcome, value] of [["filed", 3], ["duplicate", 2], ["invalid", 1], ["unsupported_host", 4], ["not_a_feed", 5], ["unreachable", 6], ["cap_reached", 7], ["admitted", 8], ["lapsed", 9]]) {
    assert.equal(sample(requests, "open_science_evolution_source_requests_total", { outcome }), value, outcome);
  }
  assert.equal(sample(requests, "open_science_evolution_source_requests_waiting"), 10);
  // A module that composed no counters says nothing rather than zeros.
  assert.equal(evolutionOpsMetricFamilies(true, await evolutionOpsSnapshot({ evolution: {} })).some((family) => family.name === "open_science_evolution_signal_groups"), false);
});
