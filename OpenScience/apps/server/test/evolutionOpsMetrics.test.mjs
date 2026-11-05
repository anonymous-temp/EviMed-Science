// A limit without an observable counter does not exist for the operator (principle 15). The module's
// limits are counted where they act and scraped from `/api/ops/metrics` (`evolutionOpsMetrics.mjs`): the tool gateway's admission, the
// platform-skill supply, the serving worker and the tool executor.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWebApiApp } from "../src/server.mjs";
import { createEvolutionVerificationController } from "../src/evolutionVerificationController.mjs";
import { createEvolutionToolAdmission } from "../src/evolutionToolAdmission.mjs";
import { createEvolutionServingWorker } from "../src/evolutionServingWorker.mjs";
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
  const refused = evolutionOpsMetricFamilies(false, null, { code: "evolution_dependency_allowlist_invalid", key: "evolutionDependencyAllowlist" });
  assert.equal(sample(refused, "open_science_evolution_refused", { code: "evolution_dependency_allowlist_invalid", key: "evolutionDependencyAllowlist" }), 1);
  assert.equal(sample(refused, "open_science_evolution_enabled"), 0);
});

test("every limit's counter reaches the scrape under a closed set of outcomes", async () => {
  // The real counters of the real classes, driven until each question has refused once.
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "os-evolution-ops-"));
  try {
    let capacity = true;
    const admission = createEvolutionToolAdmission({ config: { evolutionToolMaxConcurrentPerProject: 1, evolutionToolCallsPerMinute: 2 },
      database: { transaction: async (/** @type {any} */ run) => run({}) }, canRun: async () => true, heavyWorkAdmission: async () => capacity });
    await admission.admit({ project: { id: "p", userId: "u" } }, async () => "ok");
    capacity = false;
    await assert.rejects(admission.admit({ project: { id: "p", userId: "u" } }, async () => "x"), { code: "evolution_temporarily_unavailable" });
    capacity = true;
    await assert.rejects(admission.admit({ project: { id: "p", userId: "u" } }, async () => "x"), { code: "evolution_tool_rate_limited" });

    const supply = createPlatformSkillSupply({ dataDir, evolutionEnabled: true }, { report: () => {} });
    supply.noteFailure("platform_skill_selection_failed");

    const executor = { ok: 4, candidateFailed: 1, unavailable: 2, timedOut: 3, canceled: 0, errored: 0, dependenciesPrepared: 1, dependencyPreparationFailed: 0 };
    const snapshot = await evolutionOpsSnapshot({ evolution: { toolAdmission: admission, supply, integration: { counters: { published: 5, failed: 1 } }, executorCounters: async () => executor } });
    const families = evolutionOpsMetricFamilies(true, snapshot);
    for (const outcome of ["admitted", "refused_host_capacity", "refused_project_rate"]) {
      assert.equal(sample(families, "open_science_evolution_tool_admission_total", { outcome }), 1, outcome);
    }
    assert.equal(sample(families, "open_science_evolution_tool_admission_total", { outcome: "refused_project_concurrency" }), 0);
    assert.equal(sample(families, "open_science_evolution_platform_skill_events_total", { event: "failed" }), 1);
    assert.equal(sample(families, "open_science_evolution_events_total", { outcome: "published" }), 5);
    assert.equal(sample(families, "open_science_evolution_executor_reachable"), 1);
    assert.equal(sample(families, "open_science_evolution_executor_total", { outcome: "unavailable" }), 2);
    assert.equal(sample(families, "open_science_evolution_executor_total", { outcome: "timed_out" }), 3);
    // The families of the retired experiment engine are not exported at all, zero or otherwise.
    assert.deepEqual(families.map((family) => family.name).filter((name) => /isolation|reference_recalled|signal_groups|self_research|source_requests|heavy_window|records_folded|engine_reviews/.test(name)), []);
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
    evolutionController: { evolutionAdmissionAvailable: async () => ({ executor: { ok: 7, candidateFailed: 0, unavailable: 2, timedOut: 1, canceled: 0, errored: 0, dependenciesPrepared: 0, dependencyPreparationFailed: 0 } }) } });
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
    assert.match(text, /^open_science_evolution_serving_total\{outcome="processed"\} 0$/m);
    assert.doesNotMatch(text, /open_science_evolution_(isolation|reference_recalled)/, "the experiment engine's families are gone from the scrape");
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test("the serving worker's own counters reach the scrape, driven through the real worker", async () => {
  // Three jobs through the real worker: an experiment's event closed to the lab, a researcher's event processed, a request that cannot succeed.
  const rows = new Map([
    ["e-lab", { id: "e-lab", payload: { type: "candidate-built", status: "queued" } }],
    ["e-feedback", { id: "e-feedback", payload: { type: "researcher-feedback", status: "queued" } }],
  ]);
  const queue = ["e-lab", "e-feedback", "e-missing"].map((eventId, index) => ({ kind: "evolution-event", id: `job-${index}`, userId: "op", leaseToken: "lease", attempts: 1, payload: { eventId, eventOwnerId: "op" } }));
  const service = { now: () => new Date("2026-11-04T10:00:00Z"), owner: async () => "op", reconcileQueued: async () => {}, tools: async () => [], list: async () => [], enqueue: async () => {}, save: async () => {},
    get: async (/** @type {string} */ id) => { if (id === "e-missing") throw new HttpError(404, "evolution_event_missing", "gone"); return rows.get(id) ?? null; },
    jobs: { claim: async () => queue.shift() ?? null, renew: async () => true, finish: async (/** @type {any} */ _user, /** @type {any} */ _id, /** @type {any} */ _lease, /** @type {any} */ result) => result, fail: async () => null } };
  const worker = createEvolutionServingWorker({ service, integration: { consume: async () => {} }, config: { evolutionEnabled: true }, logger: { error() {} },
    quarantine: async () => 3, compact: async () => 9 });
  for (let tick = 0; tick < 3; tick++) await worker.tick();
  const broken = createEvolutionServingWorker({ service, integration: {}, config: { evolutionEnabled: true }, logger: { error() {} }, quarantine: async () => { throw new Error("database down"); } });
  await broken.tick();
  assert.equal(worker.counters.failed, 1);
  const families = evolutionOpsMetricFamilies(true, await evolutionOpsSnapshot({ evolution: { worker } }));
  for (const [outcome, value] of [["processed", 1], ["closed", 1], ["failed", 1], ["terminal", 1], ["quarantined", 3], ["records_deleted", 9], ["housekeeping_failed", 0]]) {
    assert.equal(sample(families, "open_science_evolution_serving_total", { outcome }), value, outcome);
  }
  assert.equal(sample(evolutionOpsMetricFamilies(true, await evolutionOpsSnapshot({ evolution: { worker: broken } })), "open_science_evolution_serving_total", { outcome: "housekeeping_failed" }), 1);
  // A module that composed no counters says nothing rather than zeros.
  assert.equal(evolutionOpsMetricFamilies(true, await evolutionOpsSnapshot({ evolution: {} })).some((family) => family.name === "open_science_evolution_serving_total"), false);
});

test('every setting a metric\'s help names is one the module has', async () => {
  const { EVOLUTION_CONFIG_SCHEMA } = await import('../src/evolutionConfiguration.mjs');
  const known = new Set(Object.values(EVOLUTION_CONFIG_SCHEMA).map((field) => field.env));
  const counters = { processed: 0 };
  const text = JSON.stringify(evolutionOpsMetricFamilies(true, { serving: counters, signals: { aggregated: {}, heldBack: {} } }));
  const named = [...text.matchAll(/OPEN_SCIENCE_[A-Z_]+/g)].map((match) => match[0]);
  assert.ok(named.length > 0);
  assert.deepEqual(named.filter((name) => !known.has(name)), []);
  assert.match(text, /open_science_evolution_signal_groups/, 'the aggregate GEO\'s outbox runs is counted');
});
