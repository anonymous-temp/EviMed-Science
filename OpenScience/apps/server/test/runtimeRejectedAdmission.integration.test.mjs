// A start whose plugin admission fails at COMMIT, after its runtime was created.
//
// The admission transaction commits once `create` has returned, and by then the
// runtime is registered for the project. A deferred foreign key is checked
// there, so a real PostgreSQL COMMIT can still reject the start with 23503
// (GEO v3 local checkpoint, 2026-10-25, "P0 — runtime cleanup after a rejected
// admission"). Every waiter was told the start failed and the runtime stayed
// running: with nobody asking for a stop, and also behind a stop that was
// waiting for that start, which returned without closing it.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PostgresStore } from "../src/store.mjs";
import { PluginService } from "../src/pluginService.mjs";
import { migrateProductStore } from "../src/productPersistence.mjs";
import { RuntimeManager } from "../src/runtimeManager.mjs";
import { loadConfig } from "../src/config.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const options = { skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL && "Disposable PostgreSQL required", timeout: 20000 };

/** One database, one pool connection, a kernel manager over provider doubles, and a deferred foreign key a start can break. */
async function rejectedAdmissionFixture(t, label) {
  const isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, label);
  const dataDir = await fs.mkdtemp("/tmp/p0-admission-");
  const config = loadConfig({
    dataDir, databaseUrl: isolated.url, stateStore: "postgres", databasePoolMax: 1, databaseConnectionTimeoutMs: 500,
    runtimeMode: "kernel", runtimeProvider: "docker", runtimeSandboxMode: "docker", runtimeTransport: "unix", runtimeNetworkMode: "bridge",
    runtimeContainerImage: "evimed-runtime:test", runtimeIdleTimeoutMs: 0, runtimeQuotaCheckIntervalMs: 0, deepseekModel: "deepseek-flash",
    modelGatewayInternalUrl: "http://gateway:8787/internal/model/v1", modelGatewaySigningSecret: "shared-test-secret-long-enough-for-gateway",
  });
  const accounts = new PostgresStore(config);
  t.after(async () => { await accounts.database.close(); await isolated.drop(); await fs.rm(dataDir, { recursive: true, force: true }); });
  await accounts.createUser("owner", "local-fixture-password", "owner");
  const owner = await accounts.userById("owner"), project = await accounts.requireProject(owner, "default");
  // The product schema a stop's admission sweep reads, as the first admission would leave it.
  await migrateProductStore(accounts.database);
  await accounts.database.query("CREATE TABLE p0_admission_parent(id text PRIMARY KEY)");
  await accounts.database.query(`CREATE TABLE p0_admission_child(parent_id text NOT NULL
    REFERENCES p0_admission_parent(id) DEFERRABLE INITIALLY DEFERRED)`);
  const m = new RuntimeManager(config);
  m.pluginService = new PluginService(accounts.database);
  m.provider.preflight = async () => {};
  m.cleanupDocker = async () => ({ cleaned: false });
  m.waitUntilReady = async () => {};
  m.idleVerdict = async () => "idle";
  m.pluginRuntimeBusy = async () => false;
  m.enforceProjectQuota = async () => {};
  m.makeRoomFor = async () => {};
  m.enforceRuntimeCapacity = () => {};
  const f = { m, accounts, project, key: m.key(project), failCommit: true, launches: [], closed: [], stopNotices: [],
    /** @type {null | ((runtime: any) => void)} */ afterRegister: null,
    /** @type {null | ((child: any) => Promise<void>)} */ onClose: null };
  let pid = 100;
  m.provider.launch = async () => { const child = new EventEmitter(); child.pid = ++pid; f.launches.push(child); return child; };
  m.provider.close = async (_project, _plan, child) => { f.closed.push(child); await f.onClose?.(child); };
  m.onRuntimeStop = async (_project, status, errorCode) => { f.stopNotices.push({ status, errorCode: errorCode ?? null }); };
  // The row is written through the admission's own client, so the database
  // refuses it only at that transaction's COMMIT, after the runtime exists.
  const boot = m.startKernel.bind(m);
  m.startKernel = async (...args) => {
    const runtime = await boot(...args);
    if (f.failCommit) await accounts.database.query("INSERT INTO p0_admission_child(parent_id) VALUES ('no-such-parent')");
    return runtime;
  };
  // Called by `create` right after it registers the runtime, inside the admission.
  const monitor = m.scheduleQuotaMonitor.bind(m);
  m.scheduleQuotaMonitor = project => { f.afterRegister?.(m.runtimes.get(m.key(project))); return monitor(project); };
  t.after(() => m.closeAll());
  return f;
}

async function ledger(project) {
  const text = await fs.readFile(path.join(project.metaDir, "runtime.jsonl"), "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map(line => JSON.parse(line));
}

test("a start whose admission COMMIT fails closes the runtime it created when nobody asks for a stop", options, async t => {
  const f = await rejectedAdmissionFixture(t, "rejectednostop"), m = f.m;
  let failed = null;
  f.afterRegister = runtime => { failed ??= runtime; };
  await assert.rejects(m.start(f.project), { code: "23503" });
  assert.ok(failed, "the runtime was created before the COMMIT");
  assert.deepEqual(f.closed, [failed.child], "the exact failed attempt is closed, once");
  assert.equal(m.runtimes.size, 0); assert.equal(m.starts.size, 0); assert.equal(m.coldStartAttempts.size, 0);
  assert.equal(m.failedRuntimeStops.size, 0);
  assert.throws(() => m.assertActiveModelGatewayToken(failed.modelGatewayToken), "its model gateway credential is withdrawn");
  assert.equal(m.startFailures.get(f.key)?.code, "23503");
  assert.deepEqual(f.stopNotices, [{ status: "failed", errorCode: null }]);
  const failures = (await ledger(f.project)).filter(row => row.event === "failed" || row.event.startsWith("cleanup_"));
  assert.deepEqual(failures.map(row => [row.event, row.error, row.stage]), [["failed", "23503", "admission"]], "the failure is recorded once");
  const state = JSON.parse(await fs.readFile(path.join(f.project.metaDir, "runtime-state.json"), "utf8"));
  assert.equal(state.event, "failed"); assert.equal(state.running, false);
  // The slot is free for the next start, which is a runtime of its own.
  f.failCommit = false;
  const next = await m.start(f.project);
  assert.notEqual(next, failed); assert.equal(m.runtimes.get(f.key), next);
  assert.equal(f.closed.length, 1, "the successful start is left running");
});

test("a stop waiting for a start whose admission COMMIT fails reports completion only after the close", options, async t => {
  const f = await rejectedAdmissionFixture(t, "rejectedstop"), m = f.m;
  let enterClose, releaseClose;
  const closeEntered = new Promise(resolve => { enterClose = resolve; });
  const closeGate = new Promise(resolve => { releaseClose = resolve; });
  f.onClose = async () => { enterClose(); await closeGate; };
  let settled = false;
  const starting = assert.rejects(m.start(f.project), { code: "23503" });
  const stopping = m.stop(f.project, { by: "user" }).then(value => { settled = true; return value; });
  try {
    assert.equal(await Promise.race([closeEntered.then(() => "closing"), stopping.then(() => "stop-settled")]), "closing",
      "the stop must not settle before the failed attempt's close begins");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, "a close in flight is not a completed stop");
  } finally { releaseClose(); }
  await starting;
  assert.equal(await stopping, false, "the stop itself had nothing to close");
  assert.equal(f.closed.length, 1); assert.equal(m.runtimes.size, 0);
  assert.equal(m.starts.size, 0); assert.equal(m.coldStartAttempts.size, 0); assert.equal(m.runtimeStops.size, 0);
});

test("a rejected admission closes only its own runtime and keeps a replacement that took the slot", options, async t => {
  const f = await rejectedAdmissionFixture(t, "rejectedreplacement"), m = f.m;
  let failed = null, replacementClosed = 0;
  const replacement = { kind: "dsh", project: f.project, workspaceDir: f.project.workspaceDir, modelGatewayTokenJti: "replacement-generation",
    close: async () => { replacementClosed += 1; } };
  f.afterRegister = runtime => { failed = runtime; m.runtimes.set(f.key, replacement); };
  await assert.rejects(m.start(f.project), { code: "23503" });
  assert.deepEqual(f.closed, [failed.child], "the failed attempt is closed by identity");
  assert.equal(m.runtimes.get(f.key), replacement); assert.equal(replacementClosed, 0);
  assert.deepEqual(f.stopNotices, [], "the project's runs and event stream belong to the replacement");
  assert.throws(() => m.assertActiveModelGatewayToken(failed.modelGatewayToken));
  m.runtimes.delete(f.key);
});

for (const changed of ["generation", "guard"]) test(`a ${changed} change during a rejected admission still closes the exact failed attempt`, options, async t => {
  const f = await rejectedAdmissionFixture(t, `rejected${changed}`), m = f.m;
  let failed = null, token = null, allowed = true;
  f.afterRegister = runtime => {
    failed = runtime; token = runtime.modelGatewayToken;
    if (changed === "generation") runtime.modelGatewayTokenJti = "changed-generation";
    else allowed = false;
  };
  const starting = assert.rejects(m.start(f.project), { code: "23503" });
  const stopping = m.stop(f.project, { guard: () => allowed });
  await starting;
  assert.equal(await stopping, false, "the stop never acts outside its own guard");
  assert.deepEqual(f.closed, [failed.child]);
  assert.equal(m.runtimes.size, 0); assert.equal(m.failedRuntimeStops.size, 0);
  assert.throws(() => m.assertActiveModelGatewayToken(token), "the credential minted for the failed attempt is withdrawn");
});

// A caller already inside its own admission runs the start in place with a
// nested admission, so the COMMIT is the caller's and comes after the start
// returned (the dispatch path, the generation workers).
for (const outcome of ["rollback", "commit"]) test(`a runtime started inside a caller's own admission is ${outcome === "commit" ? "kept when that admission commits" : "closed when that admission's COMMIT fails"}`, options, async t => {
  const f = await rejectedAdmissionFixture(t, `nested${outcome}`), m = f.m;
  f.failCommit = false;
  let runtime = null;
  const outer = m.pluginService.withAdmission(f.project, async () => {
    runtime = await m.start(f.project);
    assert.equal(m.runtimes.get(f.key), runtime, "the nested start returned before the caller's COMMIT");
    if (outcome === "rollback") await f.accounts.database.query("INSERT INTO p0_admission_child(parent_id) VALUES ('no-such-parent')");
  });
  if (outcome === "commit") {
    await outer;
    assert.deepEqual(f.closed, []); assert.equal(m.runtimes.get(f.key), runtime);
    assert.doesNotThrow(() => m.assertActiveModelGatewayToken(runtime.modelGatewayToken));
    assert.deepEqual(f.stopNotices, []);
    return;
  }
  await assert.rejects(outer, { code: "23503" });
  assert.deepEqual(f.closed, [runtime.child], "closed once the caller's transaction failed");
  assert.equal(m.runtimes.size, 0); assert.equal(m.failedRuntimeStops.size, 0); assert.equal(m.runtimeStops.size, 0);
  assert.throws(() => m.assertActiveModelGatewayToken(runtime.modelGatewayToken), "no credential stays registered");
  assert.deepEqual(f.stopNotices, [{ status: "failed", errorCode: null }]);
  const failures = (await ledger(f.project)).filter(row => row.event === "failed" || row.event.startsWith("cleanup_"));
  assert.deepEqual(failures.map(row => [row.event, row.error, row.stage]), [["failed", "23503", "admission"]]);
});

test("a rollback hook runs after the client is released and outside the transaction, and a commit runs none", options, async t => {
  const f = await rejectedAdmissionFixture(t, "rollbackhook"), database = f.accounts.database;
  await database.query("CREATE TABLE p0_hook_effects(note text NOT NULL)");
  const seen = [];
  const within = (fails) => database.transaction(client => database.withTransactionClient(client, async () => {
    assert.equal(database.afterRollback(async error => {
      seen.push(error?.code ?? null);
      // One pool connection: this would wait forever if the transaction still held it.
      await database.query("INSERT INTO p0_hook_effects(note) VALUES ('after')");
    }), true);
    if (fails) await database.query("INSERT INTO p0_admission_child(parent_id) VALUES ('no-such-parent')");
  }));
  await within(false);
  assert.deepEqual(seen, [], "a commit runs nothing");
  await assert.rejects(within(true), { code: "23503" });
  assert.deepEqual(seen, ["23503"]);
  assert.deepEqual((await database.query("SELECT note FROM p0_hook_effects")).rows, [{ note: "after" }], "the hook's own write is not rolled back with the transaction");
  assert.equal(database.afterRollback(() => assert.fail("never registered")), false, "outside a scope nothing is registered");
});
