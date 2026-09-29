// The seams between the seven packages, which is where a parallel build
// breaks. Each package's own tests pass against its own idea of the other
// side; these assert the two sides actually fit — above all the suppression
// adapter, whose failure mode is a model receiving a wrapper object *and*
// losing the suppression the plan requires (AC-26).
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import { VCR_MIN_CELL_SIZE, validateEngineResult } from "@evimed/domain";

import { loadConfig } from "../src/config.mjs";
import { removeVcrArtifacts } from "../src/vcrStoreBase.mjs";
import { suppressSmallCells } from "../src/vcrDataPlane.mjs";
import {
  composeVcr, createVcrEngineJobRemover, vcrDataPlaneSeam, vcrEngineStatus, vcrMatchingExecutor, vcrMatchingSeam,
  vcrMetricFamilies, withVcrEngineWarnings,
} from "../src/vcrComposition.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const workspaceRoot = path.resolve(repoRoot, "..");

const AS_OF = "2026-09-28T00:00:00.000Z";

/** A data-plane double with only what the seam reads. */
function dataPlaneDouble({ root = "/data/vcr" } = {}) {
  return {
    root: () => root,
    async snapshotProfileForModel({ snapshotId }) {
      return { snapshotId, columns: [{ name: "AGE", type: "number", fill: 0.99 }], quality: { completeness: 0.99 } };
    },
  };
}

function dataStoreDouble() {
  return {
    async listSources() { return [{ id: "src_1", name: "合作方样例" }]; },
    async listSnapshots() {
      return [{ id: "snp_1", sourceId: "src_1", version: 1, sha256: "a".repeat(64), rowCount: 412, columnCount: 18,
        frozenAt: AS_OF, sealedFields: ["OS_EVENT"], sealedUntil: null, quality: { completeness: 0.98 } }];
    },
  };
}

const allowAll = { async judge() { return { allowed: true }; } };
const denyAll = { async judge() { return { allowed: false, code: "vcr_no_grant", reason: "没有这个数据源的授权。" }; } };

// ---------------------------------------------------------------------------
// The suppression seam (AC-26)
// ---------------------------------------------------------------------------

test("AC-26 the seam hands a model the aggregate, not the suppressor's wrapper", async () => {
  const seam = vcrDataPlaneSeam({ dataPlane: dataPlaneDouble(), dataStore: dataStoreDouble(), access: allowAll });
  const answer = seam.suppressSmallCells({ cells: [{ key: "A", n: 3 }, { key: "B", n: 4 }, { key: "C", n: 90 }] });
  assert.ok(Array.isArray(answer.cells), "the aggregate itself comes back — a wrapper here would be handed to the model");
  assert.equal(answer.aggregate, undefined, "the `{ aggregate, suppression }` wrapper must not survive the seam");
  const suppressed = answer.cells.filter((cell) => cell.suppressed);
  assert.ok(suppressed.length >= 2, "cells below the floor are withheld");
  assert.equal(answer.suppression.minCellSize, VCR_MIN_CELL_SIZE);
  assert.ok(answer.suppression.cellsSuppressed >= 2, "the reader is told what was withheld");
});

test("AC-26 an aggregate with nothing to withhold comes back unchanged and unannotated", () => {
  const seam = vcrDataPlaneSeam({ dataPlane: dataPlaneDouble(), dataStore: dataStoreDouble(), access: allowAll });
  const answer = seam.suppressSmallCells({ cells: [{ key: "A", n: 40 }, { key: "B", n: 90 }] });
  assert.equal(answer.suppression, undefined, "no note where nothing was withheld");
  assert.deepEqual(answer.cells.map((cell) => cell.n), [40, 90]);
});

test("the seam and the data plane agree on the floor", () => {
  const direct = suppressSmallCells({ cells: [{ key: "A", n: 9 }, { key: "B", n: 90 }] }, { minCellSize: VCR_MIN_CELL_SIZE });
  const seam = vcrDataPlaneSeam({ dataPlane: dataPlaneDouble(), dataStore: dataStoreDouble(), access: allowAll });
  const through = seam.suppressSmallCells({ cells: [{ key: "A", n: 9 }, { key: "B", n: 90 }] });
  assert.equal(direct.suppression.cellsSuppressed, through.suppression.cellsSuppressed);
});

// ---------------------------------------------------------------------------
// The data-plane tab and note
// ---------------------------------------------------------------------------

test("AC-17 a caller the access judge refuses gets a named unavailable, never the rows", async () => {
  const seam = vcrDataPlaneSeam({ dataPlane: dataPlaneDouble(), dataStore: dataStoreDouble(), access: denyAll });
  const tab = await seam.tab({ id: "std_1", userId: "u1" }, { id: "u2" });
  assert.equal(tab.available, false);
  assert.equal(tab.unavailable.code, "vcr_no_grant");
  assert.equal(tab.sources, undefined);
});

test("a study at T0 is told the data plane is absent rather than shown an error", async () => {
  const seam = vcrDataPlaneSeam({ dataPlane: { root: () => "", async snapshotProfileForModel() { return {}; } },
    dataStore: dataStoreDouble(), access: allowAll });
  const note = await seam.note({ id: "std_1", dataTier: "T0" });
  assert.equal(note.available, false);
  assert.equal(note.code, "vcr_data_plane_unconfigured");
  assert.match(note.message, /T0/);
});

test("what a model may read of a snapshot is structure and quality, never a row", async () => {
  const seam = vcrDataPlaneSeam({ dataPlane: dataPlaneDouble(), dataStore: dataStoreDouble(), access: allowAll });
  const profile = await seam.runtimeProfile({ id: "std_1" }, { snapshotId: "snp_1" });
  assert.equal(profile.available, true);
  assert.ok(Array.isArray(profile.columns));
  assert.equal(JSON.stringify(profile).includes("rows"), false);
  const unnamed = await seam.runtimeProfile({ id: "std_1" }, {});
  assert.equal(unnamed.code, "vcr_snapshot_not_named");
});

// ---------------------------------------------------------------------------
// The matching seam and its local executor
// ---------------------------------------------------------------------------

const CRITERIA = [
  { id: "crt_age", kind: "inclusion", criterionType: "demographic",
    requirement: { op: "compare", variable: "age", comparator: "gte", value: 18 } },
  { id: "crt_mi", kind: "exclusion", criterionType: "time_window",
    requirement: { op: "absent", variable: "myocardial_infarction", window: { months: 6 } } },
];

function matchStoreDouble() {
  return {
    async listCriteria() { return CRITERIA; },
    async listAssessments() { return [{ id: "mas_1", subjectKey: "P-001", summary: "eligible", judgments: [] }]; },
    async listReferrals() { return [{ id: "ref_1", subjectKey: "P-001", state: "candidate" }]; },
    async listSites() { return [{ id: "ste_1", name: "中心 A", verifiedAt: AS_OF }]; },
    async screenFailureCounts() { return []; },
    async siteFunnel() { return []; },
  };
}
const storeDouble = { async latestProtocolVersion() { return { id: "prt_1", version: 1 }; } };

test("the matching tab is assembled from the package's store and its pure judgments", async () => {
  const seam = vcrMatchingSeam({ matchStore: matchStoreDouble(), store: storeDouble });
  const tab = await seam.tab({ id: "std_1", userId: "u1" }, { id: "u1" });
  assert.equal(tab.available, true);
  assert.equal(tab.criteria.length, 2);
  assert.equal(tab.protocol.id, "prt_1");
  assert.ok(tab.funnel, "the referral funnel is computed, not stored");
  assert.ok(Array.isArray(tab.sites));
  assert.ok(tab.assessments[0].counts, "an assessment carries its deterministic counts");
});

test("a run reads judgments and criteria, and nothing else the store holds", async () => {
  const seam = vcrMatchingSeam({ matchStore: matchStoreDouble(), store: storeDouble });
  assert.equal((await seam.runtimeRead({ id: "std_1" }, { what: "criteria" })).criteria.length, 2);
  assert.equal((await seam.runtimeRead({ id: "std_1" }, { what: "referrals" })).referrals.length, 1);
  assert.ok((await seam.runtimeRead({ id: "std_1" }, {})).assessments);
});

test("AC-14 the local executor decides in code and answers a valid engine result", async () => {
  const run = vcrMatchingExecutor({ matchStore: matchStoreDouble() });
  const progress = [];
  const result = await run({
    job: { id: "job_1", studyId: "std_1", scenarioHash: "b".repeat(64), seed: 7,
      scenario: { asOf: AS_OF, criteria: CRITERIA, subjects: [
        // Age known and adult; no MI evidence at all, so the exclusion is
        // `unknown` and the subject cannot read eligible (AC-14).
        { subjectKey: "P-001", facts: [{ variable: "age", value: 62, visibleAt: "2026-09-01T00:00:00.000Z" }] },
        // Nothing known at all.
        { subjectKey: "P-002", facts: [] },
      ] } },
    onProgress: async (value) => { progress.push(value); },
  });
  assert.deepEqual(validateEngineResult(result), [], "the control plane's own executor answers the engine's contract");
  assert.equal(result.status, "succeeded");
  assert.equal(result.counts.realPatients, 2);
  assert.equal(result.counts.generatedRecords, 0);
  assert.ok(progress.length >= 1, "progress is reported even for a short job");
  const summaries = result.assessments.map((row) => row.summary);
  assert.ok(!summaries.includes("eligible"), "an exclusion nobody has evidence for never reads as eligible");
  assert.equal(result.assessments[0].counts.total, 2);
  assert.equal(result.manifest.engineVersion, "control-plane");
});

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

test("the module is absent — not broken — where it is off or has no database", () => {
  assert.equal(composeVcr({ config: { vcrEnabled: false }, productDatabase: {} }), null);
  assert.equal(composeVcr({ config: { vcrEnabled: true }, productDatabase: null }), null);
});

test("composed, every package is present and the optional ones are honestly null", () => {
  const database = { async transaction(run) { return run({ async query() { return { rows: [] }; } }); }, async query() { return { rows: [] }; } };
  const vcr = composeVcr({ config: { vcrEnabled: true, vcrEngineUrl: "", vcrDataPlaneDir: "" }, productDatabase: database });
  assert.ok(vcr.store && vcr.service && vcr.jobs && vcr.access && vcr.members && vcr.evidence && vcr.matching);
  assert.equal(vcr.engine, null, "no engine URL means no engine, and the steps that need it say so");
  assert.equal(vcr.dataPlane, null, "no data-plane directory means no data plane");
  assert.equal(vcr.dataPlaneSeam, null);
  assert.equal(vcr.orchestrator, null, "the orchestrator and worker are composed beside the other modules'");
  assert.ok(vcr.jobs.localExecutors["matching.evaluate"], "the one method that runs in the control plane is registered");
});

// ---------------------------------------------------------------------------
// What leaves through the data tab, the engine's secrets, its job cleanup, the metrics
// ---------------------------------------------------------------------------

test("CS-49 the data tab names sources and snapshots and never the server's path", async () => {
  const seam = vcrDataPlaneSeam({ dataPlane: dataPlaneDouble({ root: "/srv/evimed/vcr-data-plane" }), dataStore: dataStoreDouble(), access: allowAll });
  const tab = await seam.tab({ id: "std_1", userId: "u1" }, { id: "u1" });
  assert.equal(tab.available, true);
  assert.equal(tab.snapshots.length, 1);
  assert.equal(JSON.stringify(tab).includes("/srv/evimed"), false);
  assert.equal(Object.hasOwn(tab, "root"), false);
});

/** A directory of secret files of chosen size and mode. */
async function secretFiles(/** @type {Record<string, { size?: number, mode?: number, link?: boolean }>} */ spec) {
  const dir = await mkdtemp(path.join(tmpdir(), "vcr-secrets-"));
  /** @type {Record<string, string>} */
  const files = {};
  for (const [name, { size = 40, mode = 0o440, link = false }] of Object.entries(spec)) {
    const file = path.join(dir, name);
    if (link) {
      await writeFile(path.join(dir, `${name}.real`), "x".repeat(size), { mode });
      await symlink(path.join(dir, `${name}.real`), file);
    } else {
      await writeFile(file, `${"k".repeat(size)}\n`, { mode });
      await chmod(file, mode);
    }
    files[name] = file;
  }
  return { dir, files };
}

const configWith = (/** @type {Record<string, unknown>} */ overrides) => loadConfig({ rootDir: repoRoot, vcrEnabled: true, ...overrides });

test("CS-9 the engine's token and receipt key are files, and the engine is composed only when both are readable and long enough", async (t) => {
  const { dir, files } = await secretFiles({ token: {}, receipt: {}, short: { size: 12 }, open: { mode: 0o644 }, linked: { link: true } });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const database = { async transaction(run) { return run({ async query() { return { rows: [] }; } }); }, async query() { return { rows: [] }; } };
  const url = "http://evimed-vcr-engine:8080";

  const good = configWith({ vcrEngineUrl: url, vcrEngineTokenFile: files.token, vcrEngineReceiptKeyFile: files.receipt });
  assert.equal(good.vcrEngineToken.length, 40, "read from the file, its terminator removed");
  assert.equal(good.vcrEngineConfigured, true);
  assert.deepEqual(vcrEngineStatus(good), { configured: true, reason: null });
  const composed = composeVcr({ config: good, productDatabase: database });
  assert.equal(composed?.engine?.configured(), true);
  assert.equal(typeof composed?.removeEngineJob, "function", "and the job cleanup can reach it");

  /** @type {[string, Record<string, unknown>, string][]} */
  const cases = [
    ["a token file that is not there", { vcrEngineTokenFile: path.join(dir, "absent"), vcrEngineReceiptKeyFile: files.receipt }, "vcr_engine_token_file_unavailable"],
    ["a receipt key shorter than 32 bytes", { vcrEngineTokenFile: files.token, vcrEngineReceiptKeyFile: files.short }, "vcr_engine_receipt_key_file_short"],
    ["a token file others can read", { vcrEngineTokenFile: files.open, vcrEngineReceiptKeyFile: files.receipt }, "vcr_engine_token_file_permissions"],
    ["a token file that is a symlink", { vcrEngineTokenFile: files.linked, vcrEngineReceiptKeyFile: files.receipt }, "vcr_engine_token_file_symlink"],
    ["a URL with no secret named at all", {}, "vcr_engine_secret_missing"],
    ["a token with no receipt key", { vcrEngineTokenFile: files.token }, "vcr_engine_secret_missing"],
    ["/dev/null, which compose binds where there is none", { vcrEngineTokenFile: "/dev/null", vcrEngineReceiptKeyFile: "/dev/null" }, "vcr_engine_secret_missing"],
  ];
  for (const [label, extra, reason] of cases) {
    const config = configWith({ vcrEngineUrl: url, ...extra });
    assert.equal(config.vcrEngineConfigured, false, label);
    assert.equal(vcrEngineStatus(config).reason, reason, label);
    assert.equal(composeVcr({ config, productDatabase: database, report: () => {} })?.engine, null, `${label}: no client is made`);
    const ready = withVcrEngineWarnings({ enabled: true, status: "ok", engine: "missing", warnings: ["vcr_engine_not_composed"], warning: "vcr_engine_not_composed" }, config);
    assert.equal(ready.engine, "unconfigured", label);
    assert.equal(ready.engineReason, reason, label);
    assert.ok(ready.warnings.includes("vcr_engine_unconfigured"), label);
  }
  // No URL is a valid deployment, not a misconfiguration, and adds no warning.
  const none = configWith({});
  assert.deepEqual(vcrEngineStatus(none), { configured: false, reason: "not_configured" });
  const unchanged = { enabled: true, status: "ok", engine: "missing", warnings: ["vcr_engine_not_composed"] };
  assert.deepEqual(withVcrEngineWarnings(unchanged, none), unchanged);
  assert.deepEqual(withVcrEngineWarnings({ enabled: false, status: "off" }, none), { enabled: false, status: "off" });
  assert.throws(() => configWith({ vcrEngineUrl: url, vcrEngineTokenFile: "relative/token" }), /must be an absolute path/);
});

test("the engine's secrets have no value form in the environment", async () => {
  const source = await readFile(path.join(repoRoot, "apps/server/src/config.mjs"), "utf8");
  const code = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
  for (const retired of ["OPEN_SCIENCE_VCR_ENGINE_TOKEN\"", "OPEN_SCIENCE_VCR_ENGINE_RECEIPT_KEY\"", "OPEN_SCIENCE_VCR_DAILY_BUDGET_CNY", "vcrDailyBudgetCny"]) {
    assert.equal(code.includes(retired), false, `${retired} is no longer read`);
  }
  assert.equal(Object.hasOwn(configWith({}), "vcrDailyBudgetCny"), false, "the daily budget was read nowhere and is gone");
});

test("DL-16 a job's directory is removed from the engine by its own DELETE, and only when the engine is composed", async () => {
  /** @type {any[]} */
  const seen = [];
  const config = { vcrEngineUrl: "http://engine:8080/", vcrEngineToken: "t".repeat(40), vcrEngineReceiptKey: "r".repeat(40), vcrEngineTimeoutMs: 5_000 };
  let status = 200;
  const remove = /** @type {(id: string) => Promise<void>} */ (createVcrEngineJobRemover({ config, fetchImpl: /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init) => {
    seen.push([init.method, url, init.headers.authorization]);
    return new Response("{}", { status });
  }) }));
  await remove("job_abc");
  assert.deepEqual(seen[0], ["DELETE", "http://engine:8080/jobs/job_abc", `Bearer ${"t".repeat(40)}`]);
  status = 404;
  await remove("job_gone");
  status = 500;
  await assert.rejects(() => remove("job_failing"), /vcr_engine_delete_500/);
  seen.length = 0;
  await remove("../../etc");
  assert.deepEqual(seen, [], "an id that is not an id never becomes a path");
  assert.equal(createVcrEngineJobRemover({ config: { ...config, vcrEngineToken: "" } }), null, "without the secrets there is no caller");
  assert.equal(createVcrEngineJobRemover({ config: {} }), null);
});

test("DL-13 the metric families are the platform's open_science_vcr_*, with the queue gauges and a gauge that says when it is off", () => {
  assert.deepEqual(vcrMetricFamilies(false, null).map((family) => [family.name, family.series[0].value]), [["open_science_vcr_enabled", 0]]);
  const snapshot = /** @type {any} */ ({
    tables: { jobs: { queued: 3, awaiting_budget: 1 }, studies: 12, active: 9 },
    service: { studiesCreated: 4, reads: 20, writes: 6, writeIssues: 1, notFound: 2, tabs: 30 },
    jobs: { counters: { enqueued: 7, succeeded: 5, failed: 1 } },
    orchestrator: { counters: { ticks: 10, dispatched: 3 } },
    worker: { loops: { jobs: { wired: true, stalled: false, lastOkAt: "2026-09-29T00:00:00.000Z" }, recompute: { wired: false }, orchestrator: { wired: true, stalled: true, lastOkAt: null } } },
    engine: { configured: true, reason: null },
  });
  const families = vcrMetricFamilies(true, snapshot);
  const byName = new Map(families.map((family) => [family.name, family]));
  for (const family of families) assert.match(family.name, /^open_science_vcr_[a-z_]+$/);
  assert.deepEqual(byName.get("open_science_vcr_jobs")?.series.map((series) => [series.labels?.state, series.value]),
    [["queued", 3], ["running", 0], ["awaiting_budget", 1]], "a state with no jobs reads 0, not absent");
  assert.deepEqual(byName.get("open_science_vcr_studies")?.series.map((series) => series.value), [12, 9]);
  assert.equal(byName.get("open_science_vcr_engine_configured")?.series[0].value, 1);
  assert.deepEqual(byName.get("open_science_vcr_loop_stalled")?.series.map((series) => [series.labels?.loop, series.value]), [["jobs", 0], ["orchestrator", 1]]);
  assert.deepEqual(byName.get("open_science_vcr_loop_last_ok_timestamp_seconds")?.series.map((series) => series.value), [1_790_640_000, 0]);
  assert.ok(byName.get("open_science_vcr_jobs_total")?.series.some((series) => series.labels?.outcome === "failed" && series.value === 1));
  // A schema that did not answer is reported, not read as an empty queue.
  const unreadable = new Map(vcrMetricFamilies(true, { ...snapshot, tables: null }).map((family) => [family.name, family]));
  assert.equal(unreadable.get("open_science_vcr_tables_readable")?.series[0].value, 0);
  assert.equal(unreadable.has("open_science_vcr_jobs"), false);
});

// ---------------------------------------------------------------------------
// The deployment files run the engine the way the engine reads its environment
// ---------------------------------------------------------------------------

test("DL-8 the compose stack runs the engine with the environment, secrets, paths, network and volumes the engine's own contract names", async () => {
  const compose = YAML.parse(await readFile(path.join(repoRoot, "deploy/web/docker-compose.yml"), "utf8"), { merge: true });
  const engine = compose.services["evimed-vcr-engine"];
  const web = compose.services["open-science-web"];
  const init = compose.services["evimed-vcr-jobs-init"];

  // Behind a profile: a deployment that does not run the module builds and starts no R image.
  assert.deepEqual(engine.profiles, ["vcr"]);
  assert.deepEqual(init.profiles, ["vcr"]);

  // The names the engine reads, taken from the engine's source and not from a list written here.
  const source = await readFile(path.join(workspaceRoot, "项目代码/vcr-engine/service/app.py"), "utf8");
  const read = new Set(source.match(/VCR_ENGINE_[A-Z_]+/g));
  assert.ok(read.size >= 10 && read.has("VCR_ENGINE_TOKEN_FILE"), `the engine's source names ${read.size} variables; the read did not walk`);
  const passed = Object.keys(engine.environment).sort();
  assert.deepEqual(passed, ["VCR_ENGINE_CORES", "VCR_ENGINE_CPU_SECONDS", "VCR_ENGINE_DATA_ROOT", "VCR_ENGINE_MAX_CPU_SECONDS",
    "VCR_ENGINE_MAX_REPLICATES", "VCR_ENGINE_MEMORY_BYTES", "VCR_ENGINE_RECEIPT_KEY_FILE", "VCR_ENGINE_TOKEN_FILE", "VCR_ENGINE_WORK_DIR"]);
  for (const name of passed) assert.ok(read.has(name), `${name} is passed to the engine and the engine never reads it`);
  assert.equal(engine.environment.VCR_ENGINE_WORK_DIR, "/jobs");
  assert.equal(engine.environment.VCR_ENGINE_DATA_ROOT, "/data-plane");

  // The secrets are files bound read-only the way the platform binds its other keys, on both sides.
  const bindsOf = (/** @type {any} */ service) => Object.fromEntries((service.volumes ?? []).filter((/** @type {any} */ volume) => typeof volume === "object" && volume.type === "bind")
    .map((/** @type {any} */ volume) => [volume.target, volume]));
  for (const [service, binds] of [["engine", bindsOf(engine)], ["web", bindsOf(web)]]) {
    for (const target of ["/run/secrets/vcr-engine-token", "/run/secrets/vcr-engine-receipt-key"]) {
      assert.equal(binds[target]?.read_only, true, `${service} binds ${target} read-only`);
      assert.match(String(binds[target]?.source), /^\$\{OPEN_SCIENCE_VCR_ENGINE_(TOKEN|RECEIPT_KEY)_HOST_FILE:-\/dev\/null\}$/, `${service}: ${target} is a host file, /dev/null where there is none`);
    }
  }
  assert.equal(engine.environment.VCR_ENGINE_TOKEN_FILE, "/run/secrets/vcr-engine-token");
  assert.equal(web.environment.OPEN_SCIENCE_VCR_ENGINE_TOKEN_FILE, "/run/secrets/vcr-engine-token");
  assert.equal(web.environment.OPEN_SCIENCE_VCR_ENGINE_RECEIPT_KEY_FILE, "/run/secrets/vcr-engine-receipt-key");

  // The data plane: one host directory, read-write in the control plane, read-only in the engine, one path.
  const planeWeb = bindsOf(web)["/data-plane"];
  const planeEngine = bindsOf(engine)["/data-plane"];
  assert.ok(planeWeb && planeEngine);
  assert.equal(planeWeb.source, planeEngine.source, "the same host directory on both sides");
  assert.notEqual(planeWeb.read_only, true, "the control plane writes uploads and derived tables");
  assert.equal(planeEngine.read_only, true, "the engine only reads");
  assert.equal(web.environment.OPEN_SCIENCE_VCR_DATA_PLANE_DIR, "${OPEN_SCIENCE_VCR_DATA_PLANE_HOST_DIR:+/data-plane}",
    "the config names the plane exactly when the host directory is bound");

  // /jobs is a named volume, given to the uid the engine runs as by a one-shot that holds CAP_CHOWN and nothing else.
  assert.ok((engine.volumes ?? []).includes("evimed-vcr-jobs:/jobs"));
  assert.ok(Object.hasOwn(compose.volumes, "evimed-vcr-jobs"));
  assert.deepEqual(init.entrypoint, ["chown", "10001:10001", "/jobs"]);
  assert.deepEqual(init.volumes, ["evimed-vcr-jobs:/jobs"]);
  assert.deepEqual(init.cap_add, ["CHOWN"]);
  assert.deepEqual(init.cap_drop, ["ALL"]);
  assert.equal(init.network_mode, "none");
  assert.equal(engine.user, "10001:10001");
  assert.equal(engine.depends_on["evimed-vcr-jobs-init"].condition, "service_completed_successfully");

  // The engine's only network is an internal one shared with the control plane and nobody else.
  assert.deepEqual(engine.networks, ["vcr-engine-internal"]);
  assert.equal(compose.networks["vcr-engine-internal"].internal, true);
  assert.ok(web.networks.includes("vcr-engine-internal"));
  const onIt = Object.entries(compose.services).filter(([, service]) => JSON.stringify(service.networks ?? []).includes("vcr-engine-internal")).map(([name]) => name).sort();
  assert.deepEqual(onIt, ["evimed-vcr-engine", "open-science-web"]);
  assert.equal(engine.cap_drop.includes("ALL"), true);
  assert.equal(engine.read_only, true);
  // Its liveness check is the route that needs no token.
  assert.match(engine.healthcheck.test.join(" "), /\/livez/);
});

test("DL-9 DL-11 DL-12 DL-19 the web image carries the profiler, the release manifest binds it, the overlay keeps the module off, and every variable is documented", async () => {
  const dockerfile = await readFile(path.join(repoRoot, "deploy/web/Dockerfile"), "utf8");
  assert.match(dockerfile, /^COPY --from=build \/app\/scripts\/vcr \.\/scripts\/vcr$/m);
  const manifest = await readFile(path.join(repoRoot, "scripts/ops/generate-release-manifest.mjs"), "utf8");
  assert.match(manifest, /^ {2}"scripts\/vcr",$/m);
  const overlay = await readFile(path.join(repoRoot, "deploy/web/docker-compose.api-only.yml"), "utf8");
  assert.match(overlay, /OPEN_SCIENCE_VCR_ENABLED: \$\{OPEN_SCIENCE_VCR_ENABLED:-false\}/);
  const delta = await readFile(path.join(repoRoot, "scripts/ops/host-engine-delta.sh"), "utf8");
  assert.match(delta, /EVIMED_VCR_ENGINE_IMAGE/);
  assert.match(delta, /R\/package-lock\.json differs from the running image's; build it in full/);

  const example = await readFile(path.join(repoRoot, "deploy/web/.env.example"), "utf8");
  const documented = new Set([...example.matchAll(/^#? *((?:OPEN_SCIENCE|EVIMED)_VCR_[A-Z0-9_]+)=/gm)].map((match) => match[1]));
  const composeText = await readFile(path.join(repoRoot, "deploy/web/docker-compose.yml"), "utf8");
  const named = new Set(composeText.match(/(?:OPEN_SCIENCE|EVIMED)_VCR_[A-Z0-9_]+/g));
  // The variables an operator sets are the ones compose interpolates from `.env`, and the ones the control plane reads.
  const operator = [...named].filter((name) => !/(_FILE|_DIR)$/.test(name) || /HOST_(FILE|DIR)$/.test(name));
  const undocumented = operator.filter((name) => !documented.has(name)).sort();
  assert.deepEqual(undocumented, [], `.env.example names ${[...documented].length} vcr variables and lacks ${undocumented.join(", ")}`);
  for (const gone of ["OPEN_SCIENCE_VCR_DAILY_BUDGET_CNY", "OPEN_SCIENCE_VCR_ENGINE_TOKEN", "OPEN_SCIENCE_VCR_ENGINE_RECEIPT_KEY", "OPEN_SCIENCE_VCR_DATA_PLANE_DIR"]) {
    assert.equal(documented.has(gone), false, `${gone} is not an operator setting any more`);
  }
  assert.equal(composeText.includes("OPEN_SCIENCE_VCR_DAILY_BUDGET_CNY"), false);
});

test("CS-43 removing a deleted study's files stays inside the data plane: `..`, an absolute path and a symlinked directory are refused, never followed", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "vcr-plane-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const plane = path.join(dir, "plane");
  const outside = path.join(dir, "outside");
  await mkdir(path.join(plane, "study-a"), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.txt"), "not the plane's");
  await writeFile(path.join(dir, "sibling.txt"), "not the plane's either");
  await writeFile(path.join(plane, "study-a", "snapshot.csv"), "id\n1\n");
  await writeFile(path.join(plane, "keep.csv"), "another study's file\n");
  await symlink(outside, path.join(plane, "linked"));
  const exists = (/** @type {string} */ file) => stat(file).then(() => true, () => false);
  /** @type {string[]} */
  const reported = [];
  const removed = await removeVcrArtifacts({
    dataPlaneDir: plane,
    artifacts: { locations: ["study-a/snapshot.csv", "../sibling.txt", path.join(outside, "secret.txt"), "linked/secret.txt", "study-a/never-existed.csv"], engineJobIds: [] },
    report: (code) => reported.push(code),
  });
  assert.equal(await exists(path.join(plane, "study-a", "snapshot.csv")), false, "the study's file is gone");
  assert.equal(await exists(path.join(plane, "study-a")), false, "and the empty directory it made");
  assert.equal(await exists(path.join(plane, "keep.csv")), true, "another study's file is untouched");
  assert.equal(await exists(path.join(dir, "sibling.txt")), true, "a `..` location left the plane and was refused");
  assert.equal(await exists(path.join(outside, "secret.txt")), true, "an absolute path and a symlinked directory were not followed");
  assert.deepEqual(reported.filter((code) => code === "vcr_artifact_outside_plane").length, 3);
  assert.ok(removed.files >= 1);
  // No plane configured, or nothing collected: nothing happens and nothing throws.
  assert.deepEqual(await removeVcrArtifacts({ dataPlaneDir: "", artifacts: { locations: ["x"], engineJobIds: [] } }), { files: 0, engineJobs: 0 });
  assert.deepEqual(await removeVcrArtifacts({ dataPlaneDir: plane, artifacts: null }), { files: 0, engineJobs: 0 });
  // An engine that cannot be reached is reported for each job, and does not stop the rest.
  /** @type {string[]} */
  const told = [];
  const engineReport = [];
  const outcome = await removeVcrArtifacts({
    dataPlaneDir: "", artifacts: { locations: [], engineJobIds: ["job_a", "job_b"] },
    engineRemove: async (id) => { told.push(id); if (id === "job_a") throw new Error("engine down"); },
    report: (code) => engineReport.push(code),
  });
  assert.deepEqual(told, ["job_a", "job_b"]);
  assert.deepEqual(outcome, { files: 0, engineJobs: 1 });
  assert.deepEqual(engineReport, ["vcr_engine_job_remove_failed"]);
});
