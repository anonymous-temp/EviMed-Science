// The availability projection over the real capability registry: what it gathers, what it leaves unknown, and
// that it is only ever a label. The ladder itself is the domain's (packages/domain/test/capabilityAvailability).
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CAPABILITY_DISPLAY, VCR_CAPABILITIES } from "@evimed/domain";
import { loadAgentRegistry, EVIMED_AGENT_TOOL_IDS } from "../src/agentRegistry.mjs";
import { loadConfig } from "../src/config.mjs";
import { EngineHealthProbe } from "../src/availabilityEngineProbe.mjs";
import { AvailabilityService, availabilityMetricFamilies, coordinateVersion, publicAvailability } from "../src/availabilityService.mjs";
import { AvailabilityStore } from "../src/availabilityStore.mjs";
import { AvailabilityCollector, AvailabilityWorker } from "../src/availabilityCollector.mjs";
import { FakeAvailabilityDatabase, FakeJobs } from "./helpers/availabilityFakes.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const registry = loadAgentRegistry({ packageDirs: loadConfig({ rootDir: repoRoot }).agentPackageDirs, capabilityDirs: loadConfig({ rootDir: repoRoot }).capabilityDirs });
const alice = { id: "alice" };

const adapters = {
  metaAnalysis: "http://meta:8024/api/v1/evimed/meta-analysis", mendelianRandomization: "http://mr:8026/api/v1/x",
  bibliometricAnalysis: "http://bib:8027/x", researchTopicSelection: "http://topic:8028/x", peerReview: "http://review:8029/x",
  drugSafetyAnalysis: "http://evimed-drug-safety-agent:8025/api/v1/evimed/drug-safety-analysis",
};
const config = (overrides = {}) => ({
  runtimeMode: "kernel", runtimeProvider: "docker", evimedDisabledTools: "", evimedAdapterUrls: adapters, specialistAgents: {},
  publicSourceGatewayInternalUrl: "http://127.0.0.1:8787/internal/sources/v1/fetch", modelGatewayInternalUrl: "http://127.0.0.1:8787/internal/model/v1",
  operatorUsers: [], publicSourceCredentials: {}, availabilityEnabled: true, ...overrides,
});

/** A service over a fake record store, and a way to put a delivered run into it through the real collector. */
function build({ cfg = config(), health = {}, connectors = null, validation = null, extensionViews = null, withStore = true, vcrEngine = null } = {}) {
  const database = new FakeAvailabilityDatabase();
  const jobs = new FakeJobs(database);
  const store = withStore ? new AvailabilityStore(database) : null;
  const probe = new EngineHealthProbe({ config: cfg, ttlMs: 0, fetchImpl: async (url) => {
    const answer = health[new URL(url).host];
    if (answer === "down") throw new Error("ECONNREFUSED");
    return { ok: answer !== "degraded", json: async () => (answer === "degraded" ? { ready: false, serving: true } : { ready: true, serving: true, specialistSlots: { limit: 2, running: 1, waiting: 0 } }) };
  } });
  const service = new AvailabilityService({
    config: cfg, registry, store, engineProbe: probe, vcrEngine, connectorStatus: connectors, methodValidation: validation, extensionViews,
    now: () => new Date("2026-10-04T12:00:00.000Z"),
  });
  const deliver = async (capabilityId, version, id = "run_1", tools = []) => {
    const manifest = (await registry).get(capabilityId);
    const collector = new AvailabilityCollector({
      jobs, store, documents: { list: async () => ({ items: [] }) }, resolveProject: async () => ({ id: "project-1", userId: "alice" }),
      readRuns: async () => [{ id, status: "succeeded", effectiveAgentId: capabilityId, effectiveAgentVersion: version, finishedAt: "2026-10-03T09:00:00.000Z",
        durationMs: 100_000, artifacts: ["x"] }],
      readTranscript: async () => ({ messages: [{ role: "assistant", time: 1, parts: tools.map((tool) => ({ type: "tool", tool, callId: tool, status: "completed", input: {}, output: JSON.stringify({ status: "success" }) })) }] }),
      costOf: async () => 1, listFinishedRuns: async () => [], manifestOf: async () => ({ manifest, bodyDigest: null }), now: () => new Date("2026-10-03T09:30:00.000Z"),
    });
    await collector.enqueueRun({ id: "project-1", userId: "alice" }, { id, status: "succeeded" });
    await new AvailabilityWorker({ jobs, collector }).tick();
    await collector.enqueueSweep("alice", "p");
    await new AvailabilityWorker({ jobs, collector }).tick();
  };
  return { service, database, deliver, probe };
}

const stateOf = (entries, id) => entries.find((entry) => entry.id === id);

test("with no collector and no records every capability the deployment carries reads unverified, and none reads executable", async () => {
  const { service } = build({ withStore: false });
  const entries = await service.capabilities(alice);
  assert.ok(entries.length >= 24, `walked ${entries.length} capabilities`);
  assert.equal(entries.filter((entry) => entry.state === "executable").length, 0);
  assert.equal(stateOf(entries, "adr-analysis").state, "unverified");
  assert.equal(stateOf(entries, "adr-analysis").reason.code, "collector-off");
  assert.equal(stateOf(entries, "adr-analysis").version, "1.3.1");
});

test("a mock runtime never yields executable, not even over a record of a success", async () => {
  const { service, deliver } = build({ cfg: config({ runtimeMode: "mock" }) });
  await deliver("adr-analysis", "1.3.1");
  const entry = stateOf(await service.capabilities(alice), "adr-analysis");
  assert.equal(entry.state, "unverified");
  assert.equal(entry.reason.code, "mock-runtime");
  assert.equal(entry.operations.successes, 1, "the record is shown, it just is not a claim about a real kernel");
});

test("a delivered run of this exact version makes it executable, and a different version of the registry does not inherit it", async () => {
  const { service, deliver } = build();
  assert.equal(stateOf(await service.capabilities(alice), "adr-analysis").state, "unverified", "records still forming: no sweep has finished");
  await deliver("adr-analysis", "1.3.1");
  const entries = await service.capabilities(alice);
  const adr = stateOf(entries, "adr-analysis");
  assert.equal(adr.state, "executable");
  assert.equal(adr.operations.lastSuccessAt, "2026-10-03T09:00:00.000Z");
  assert.equal(adr.operations.typicalDurationMs, 100_000);
  // Every other capability has never run here and says so, not "executable".
  assert.equal(stateOf(entries, "meta-analysis").state, "installed");
  assert.equal(stateOf(entries, "meta-analysis").reason.code, "no-successful-operation");
  // A record for another version of the same id is another subject: the registry's version is the only one read.
  const { service: other, deliver: deliverOld } = build();
  await deliverOld("adr-analysis", "1.0.0");
  assert.equal(stateOf(await other.capabilities(alice), "adr-analysis").state, "installed");
});

test("an engine that says it is down limits its capability and its tool, and the capability is still listed", async () => {
  const { service, deliver } = build({ health: { "evimed-drug-safety-agent:8025": "down" } });
  await deliver("adr-analysis", "1.3.1");
  const adr = stateOf(await service.capabilities(alice, { freshEngines: true }), "adr-analysis");
  assert.equal(adr.state, "limited");
  assert.equal(adr.reason.code, "engine-not-ready");
  assert.equal(adr.reason.facts.engineState, "unreachable");
  assert.match(adr.text, /提交后仍会受理/);
  assert.equal(adr.operations.successes, 1, "a success of last week is not lost, only outranked by today's fact");
  const tool = stateOf(await service.tools(alice), "drug_safety_analysis");
  assert.equal(tool.state, "limited");
  // An engine that answers and says it is not ready is `degraded`; one that was never asked is not called ready or limited.
  const degraded = build({ health: { "evimed-drug-safety-agent:8025": "degraded" } });
  assert.equal(stateOf(await degraded.service.tools(alice, { freshEngines: true }), "drug_safety_analysis").reason.facts.engineState, "degraded");
  const unasked = build({ cfg: config({ evimedAdapterUrls: { ...adapters, drugSafetyAnalysis: "" } }) });
  assert.equal(stateOf(await unasked.service.tools(alice), "drug_safety_analysis").reason.code, "engine-not-configured");
});

test("an engine that is not configured at all makes its tool unavailable and its capability say what it depends on", async () => {
  const { service } = build({ cfg: config({ evimedAdapterUrls: { ...adapters, mendelianRandomization: "" } }) });
  const tool = stateOf(await service.tools(alice), "mendelian_randomization");
  assert.equal(tool.state, "unavailable");
  assert.equal(tool.reason.code, "engine-not-configured");
  const mr = stateOf(await service.capabilities(alice), "mendelian-randomization");
  assert.equal(mr.state, "unavailable");
  assert.ok(["engine-not-configured", "required-tool-not-offered"].includes(mr.reason.code));
});

test("a data source the account has no credential for limits the capability that names it, and a key the account holds does not", async () => {
  const missing = build({ connectors: async () => [{ id: "opengwas", source: "none" }, { id: "openfda", source: "none" }] });
  const mr = stateOf(await missing.service.capabilities(alice), "mendelian-randomization");
  assert.equal(mr.state, "limited");
  assert.deepEqual([mr.reason.code, mr.reason.detail], ["data-source-not-configured", "opengwas"]);
  // openfda is keyless (works without a key, only slower): never a limit.
  assert.notEqual(stateOf(await missing.service.capabilities(alice), "adr-analysis").reason.code, "data-source-not-configured");
  const held = build({ connectors: async () => [{ id: "opengwas", source: "user" }] });
  assert.notEqual(stateOf(await held.service.capabilities(alice), "mendelian-randomization").reason.code, "data-source-not-configured");
  // Unreadable credentials claim no limit: unknown stays unknown.
  const broken = build({ connectors: async () => { throw new Error("db"); } });
  assert.notEqual(stateOf(await broken.service.capabilities(alice), "mendelian-randomization").reason.code, "data-source-not-configured");
});

test("a module-only capability is unavailable where its module is off, and where the account is outside its audience", async () => {
  const off = await build().service.capabilities(alice);
  for (const id of VCR_CAPABILITIES) {
    assert.equal(stateOf(off, id).state, "unavailable", id);
    assert.equal(stateOf(off, id).reason.code, "module-off");
  }
  const closed = await build({ cfg: config({ vcrEnabled: true, vcrAudience: "operators", geoEnabled: true, geoAudience: "operators" }) }).service.capabilities(alice);
  assert.equal(stateOf(closed, "vcr-protocol").reason.code, "module-not-open");
  assert.equal(stateOf(closed, "geo-insight").reason.code, "module-not-open");
  // The deployment's own view has every audience open, so the operator's export reads the module itself.
  const everyone = await build({ cfg: config({ vcrEnabled: true, vcrAudience: "operators", vcrEngineConfigured: true }) }).service.capabilities(null);
  assert.notEqual(stateOf(everyone, "vcr-protocol").state, "unavailable");
});

test("a method not yet measured limits the virtual-clinical-research capabilities, and only while the module is on", async () => {
  const { service } = build({ cfg: config({ vcrEnabled: true, vcrAudience: "all", vcrEngineConfigured: true }), validation: async () => ({ status: "unmeasured", reason: "not_configured" }) });
  const entry = stateOf(await service.capabilities(alice), "vcr-analysis");
  assert.equal(entry.state, "limited");
  assert.equal(entry.reason.code, "method-unmeasured");
  const verified = build({ cfg: config({ vcrEnabled: true, vcrAudience: "all", vcrEngineConfigured: true }), validation: async () => ({ status: "verified" }) });
  assert.notEqual(stateOf(await verified.service.capabilities(alice), "vcr-analysis").reason.code, "method-unmeasured");
});

// The same reading the job a page shows and readiness read (`vcrEngineProbe.mjs`): a label that says the engine is
// not answering while the page's job says it is working would be three tellings of one fact.
test("the statistics engine not answering limits the capabilities that compute with it, and only says what is known", async () => {
  const cfg = config({ vcrEnabled: true, vcrAudience: "all", vcrEngineConfigured: true });
  const read = async (reading, id = "vcr-analysis") => stateOf(await build({ cfg, vcrEngine: () => reading }).service.capabilities(alice), id);

  const down = await read({ state: "not_answering", code: "vcr_engine_unreachable", checkedAt: "2026-10-05T07:00:00.000Z" });
  assert.equal(down.state, "limited");
  assert.equal(down.reason.code, "vcr-engine-not-answering");
  assert.equal(down.reason.source, "engine-health");
  assert.match(down.text, /没有回应.*自动继续/);

  const missing = await read({ state: "not_configured", code: null, checkedAt: null });
  assert.equal(missing.state, "limited");
  assert.equal(missing.reason.code, "vcr-engine-not-configured");

  // Answering, nobody having asked yet, and no reader at all say nothing about the engine.
  for (const reading of [{ state: "answering", code: null, checkedAt: "x" }, { state: "unknown", code: null, checkedAt: null }, null]) {
    assert.notEqual((await read(reading)).reason.code, "vcr-engine-not-answering");
    assert.notEqual((await read(reading)).reason.code, "vcr-engine-not-configured");
  }
  // A reader that throws is no reading, never a failed catalogue.
  const broken = await stateOf(await build({ cfg, vcrEngine: () => { throw new Error("probe"); } }).service.capabilities(alice), "vcr-analysis");
  assert.ok(broken.state);
  // Only while the module is on: off stays off, whatever the engine says.
  const off = stateOf(await build({ vcrEngine: () => ({ state: "not_answering", code: null, checkedAt: null }) }).service.capabilities(alice), "vcr-analysis");
  assert.equal(off.reason.code, "module-off");
});

test("a capability only the source names is source-planned, and is never in the deployed catalogue", async () => {
  const { service } = build();
  const entries = await service.capabilities(alice);
  const deployed = new Set((await registry).list({ includeInternal: true }).map((agent) => agent.id));
  for (const id of Object.keys(CAPABILITY_DISPLAY)) {
    if (deployed.has(id)) continue;
    assert.equal(stateOf(entries, id).state, "source-planned", id);
  }
  const lacking = loadAgentRegistry({ packageDirs: loadConfig({ rootDir: repoRoot }).agentPackageDirs, capabilityDirs: [] });
  const thin = new AvailabilityService({ config: config(), registry: lacking, now: () => new Date() });
  const planned = (await thin.capabilities(alice)).filter((entry) => entry.state === "source-planned");
  assert.ok(planned.length > 0, "a deployment missing the capability roots says the source's capabilities are only planned");
});

test("a tool the deployment declines is unavailable with its reason, and the whole catalogue of tools is walked", async () => {
  const { service, deliver } = build();
  assert.equal(stateOf(await service.tools(alice), "literature_search").state, "unverified", "before the first collection pass has finished, nothing is claimed either way");
  await deliver("adr-analysis", "1.3.1");
  const tools = await service.tools(alice);
  assert.deepEqual(tools.map((entry) => entry.id).sort(), [...EVIMED_AGENT_TOOL_IDS].sort(), "every tool the catalogue names has a state");
  assert.equal(stateOf(tools, "patent_search").state, "unavailable");
  assert.equal(stateOf(tools, "frontier_search").reason.code, "module-off");
  assert.equal(stateOf(tools, "literature_search").state, "installed");
});

test("the account's extensions read their exact version and lifecycle, with the evidence labels beside the state", async () => {
  const views = [
    { id: "ext-1", catalogueId: "cowork-docs", coordinate: { kind: "npm", name: "@x/cowork", version: "1.2.0" }, integrity: "sha256:" + "a".repeat(64), phase: "waiting", evidenceState: "saas-qualified" },
    { id: "ext-2", catalogueId: "viewer", coordinate: { kind: "github", repository: "a/b", commit: "f".repeat(40) }, integrity: "sha256:" + "b".repeat(64), phase: "removed", evidenceState: "source-assessed" },
    { id: "ext-3", catalogueId: "local", coordinate: { kind: "npm", name: "l", version: "0.1.0" }, integrity: "sha256:" + "c".repeat(64), phase: "unsupported", executionClass: "local-only" },
    { id: "ext-4", catalogueId: "busy", coordinate: { kind: "npm", name: "b", version: "2.0.0" }, integrity: "sha256:" + "d".repeat(64), phase: "preparing" },
    { id: "ext-5", catalogueId: "broken", coordinate: { kind: "npm", name: "k", version: "3.0.0" }, integrity: "sha256:" + "e".repeat(64), phase: "failed", preparation: { refusalCode: "extension_contract_invalid" } },
  ];
  const { service } = build({ extensionViews: async () => views });
  const entries = await service.extensions(alice);
  const by = Object.fromEntries(entries.map((entry) => [entry.id, entry]));
  assert.equal(by["cowork-docs"].version, "1.2.0");
  assert.equal(by["cowork-docs"].state, "unverified", "use of an extension is not collected: waiting and prepared is not shown as run");
  assert.equal(by["cowork-docs"].reason.code, "use-not-collected");
  assert.match(by["cowork-docs"].text, /1\.2\.0 版已准备好/);
  assert.equal(by.viewer.version, "ffffffffffff");
  assert.equal(by.viewer.state, "unavailable");
  assert.equal(by.viewer.reason.code, "removed");
  assert.equal(by.local.reason.code, "unsupported");
  assert.equal(by.local.reason.detail, "local-only");
  assert.equal(by.busy.state, "source-planned");
  assert.equal(by.broken.reason.code, "preparation-failed");
  assert.equal(coordinateVersion({ kind: "nope" }), null);
  // A failure to read the installations is an empty list, never a failed page.
  assert.deepEqual(await build({ extensionViews: async () => { throw new Error("db"); } }).service.extensions(alice), []);
});

test("an ordinary reader is never handed a run, a dispatch or a project", async () => {
  const { service, deliver } = build();
  await deliver("adr-analysis", "1.3.1", "run_secret_1");
  const body = await service.forAccount(alice);
  const text = JSON.stringify(body);
  for (const secret of ["run_secret_1", "dispatch", "session-", "project-1"]) assert.equal(text.includes(secret), false, secret);
  assert.deepEqual(Object.keys(body).sort(), ["capabilities", "collector", "extensions", "generatedAt", "skills", "tools"]);
  assert.deepEqual(publicAvailability(stateOf(await service.capabilities(alice), "adr-analysis")).operations.successes, 1);
});

test("the operator's export carries every record with the references the release audit cites", async () => {
  const { service, deliver } = build({ health: { "evimed-drug-safety-agent:8025": "degraded" } });
  await deliver("adr-analysis", "1.3.1", "run_9", ["mcp__evimed__drug_safety_analysis"]);
  const exported = await service.export();
  assert.equal(exported.kind, "evimed-availability-export");
  assert.equal(exported.schemaVersion, 1);
  assert.equal(exported.deployment.runtimeMode, "kernel");
  const record = exported.records.find((row) => row.kind === "capability" && row.id === "adr-analysis");
  assert.equal(record.lastSuccess.runId, "run_9");
  assert.equal(record.lastSuccess.projectId, "project-1");
  assert.equal(exported.records.find((row) => row.kind === "tool" && row.id === "drug_safety_analysis").successes, 1);
  assert.equal(exported.engines.drug_safety_analysis.state, "degraded", "engines are asked afresh for the export");
  assert.equal(exported.counts.capability.limited >= 1, true);
  assert.equal(exported.collector.sweptOnce, true);
  assert.equal(stateOf(exported.states, "adr-analysis").reason.source, "engine-health");
  // The export is the deployment's own view: the unmeasured modules read as modules, not as closed to a particular account.
  assert.equal(JSON.stringify(exported).includes("password"), false);
});

test("a record store that cannot be read makes every label unverified instead of failing the catalogue", async () => {
  const { service, database } = build();
  database.failNextRead = true;
  const entries = await service.capabilities(alice);
  assert.equal(stateOf(entries, "adr-analysis").state, "unverified");
  assert.equal(stateOf(entries, "adr-analysis").reason.code, "records-unreadable");
});

test("the operators' series are closed sets, name no account's work and fall back to the enabled gauge alone", async () => {
  const { service, deliver } = build();
  await deliver("adr-analysis", "1.3.1", "run_1", ["mcp__evimed__web_read"]);
  const snapshot = await service.metrics();
  const families = availabilityMetricFamilies(true, snapshot);
  const names = families.map((family) => family.name);
  assert.deepEqual(names, [
    "open_science_availability_enabled", "open_science_availability_subjects", "open_science_availability_operations_total",
    "open_science_availability_collector_backlog", "open_science_availability_collector_failed_jobs", "open_science_availability_records",
    "open_science_availability_collector_state",
  ]);
  const subjects = families.find((family) => family.name === "open_science_availability_subjects").series;
  assert.equal(subjects.length, 12, "two kinds times six states, every one present");
  assert.ok(subjects.find((row) => row.labels.kind === "capability" && row.labels.state === "executable").value >= 1);
  const operations = families.find((family) => family.name === "open_science_availability_operations_total").series;
  assert.equal(operations.find((row) => row.labels.kind === "tool" && row.labels.outcome === "success").value, 1);
  for (const family of families) for (const row of family.series) for (const value of Object.values(row.labels ?? {})) assert.match(value, /^[a-z_-]+$/, `${family.name} label ${value}`);
  assert.deepEqual(availabilityMetricFamilies(false, null).map((family) => family.series[0].value), [0]);
  assert.equal(availabilityMetricFamilies(true, null).length, 1);
});

test("the engine probe is bounded, reads five scalars and never echoes an upstream body", async () => {
  const bodies = [];
  const probe = new EngineHealthProbe({ config: config(), ttlMs: 0, fetchImpl: async (url, options) => {
    assert.equal(options.redirect, "error", "a redirect is never followed to somewhere the adapter did not name");
    assert.ok(options.signal, "every ask has a deadline");
    bodies.push(url);
    return { ok: true, json: async () => ({ ready: true, serving: true, secret: "sk-must-never-appear", sourceEvidence: "x".repeat(500), specialistSlots: { limit: 1, running: 0, waiting: 0, token: "nope" } }) };
  } });
  const result = await probe.refresh({ force: true });
  assert.equal(result.size, 6);
  const facts = result.get("meta_analysis").facts;
  assert.equal(JSON.stringify(facts).includes("sk-must-never-appear"), false);
  assert.equal("sourceEvidence" in facts, false, "an overlong string is not a label");
  assert.deepEqual(facts.specialistSlots, { limit: 1, running: 0, waiting: 0 });
  assert.equal(bodies.every((url) => url.endsWith("/health")), true);
  // A refresh is one round at a time, and a fresh snapshot is not asked again.
  let asked = 0;
  const lazy = new EngineHealthProbe({ config: config(), ttlMs: 60_000, fetchImpl: async () => { asked += 1; return { ok: true, json: async () => ({ ready: true }) }; } });
  await Promise.all([lazy.refresh(), lazy.refresh(), lazy.refresh()]);
  assert.equal(asked, 6);
  await lazy.refresh();
  assert.equal(asked, 6);
});

test("engine readiness is one yes or no each: only a positive answer is a yes, and the VCR engine is read from its own probe", async () => {
  const { service } = build({ health: { "meta:8024": "down", "mr:8026": "degraded" } });
  const rows = await service.engineReadiness(alice);
  const byId = Object.fromEntries(rows.map((row) => [row.id, row.available]));
  assert.deepEqual(Object.keys(byId).sort(), ["bibliometric_analysis", "drug_safety_analysis", "mendelian_randomization", "meta_analysis", "peer_review", "research_topic_selection", "vcr"]);
  assert.equal(byId.meta_analysis, false, "an engine that did not answer is not available");
  assert.equal(byId.mendelian_randomization, false, "an engine that answered that it is not ready is not available");
  assert.equal(byId.bibliometric_analysis, true);
  assert.equal(byId.peer_review, true);
  assert.equal(byId.vcr, false, "the module is off here, so its engine is not on offer");
  assert.ok(rows.every((row) => typeof row.available === "boolean"), "never a third word");

  const on = build({ cfg: config({ vcrEnabled: true, vcrAudience: "all" }), vcrEngine: () => ({ state: "answering", code: null, checkedAt: null }) });
  assert.equal((await on.service.engineReadiness(alice)).find((row) => row.id === "vcr")?.available, true);
  const silent = build({ cfg: config({ vcrEnabled: true, vcrAudience: "all" }), vcrEngine: () => ({ state: "not_answering", code: "x", checkedAt: null }) });
  assert.equal((await silent.service.engineReadiness(alice)).find((row) => row.id === "vcr")?.available, false);
});

test("an engine reading that has not been made yet is asked for before the page says anything", async () => {
  let asked = 0;
  const { service } = build({ cfg: config({ vcrEnabled: true, vcrAudience: "all" }), vcrEngine: () => ({ state: "unknown", code: null, checkedAt: null }) });
  service.vcrEngineRefresh = async () => { asked += 1; return { state: "answering", code: null, checkedAt: "2026-10-07T00:00:00.000Z" }; };
  assert.equal((await service.engineReadiness(alice)).find((row) => row.id === "vcr")?.available, true);
  assert.equal(asked, 1);
});

test("a deployment that composes no engine adapter reports every specialist engine as not available", async () => {
  const { service } = build({ cfg: config({ evimedAdapterUrls: {} }) });
  const rows = await service.engineReadiness(alice);
  assert.deepEqual(rows.filter((row) => row.id !== "vcr").map((row) => row.available), [false, false, false, false, false, false]);
});
