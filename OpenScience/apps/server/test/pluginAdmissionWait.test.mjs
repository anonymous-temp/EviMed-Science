// A start or a prompt that meets a plugin apply waits for it instead of failing.
//
// 2026-10-04, live: for ten to forty seconds after a release the first
// conversation of a project with saved plugin settings answered 423
// `plugin_apply_in_progress` — the apply that verifies a newly started runtime
// restarts it and probes the plugin while holding the project's exclusive lock,
// and the admission asked for its shared counterpart once and refused. The
// kernel's own page said 「对话暂时打不开」 and the acceptance drivers failed.
// The wait belongs to the server; this holds the loop on a database that models
// the lock (the real fence is `pluginService.integration.test.mjs`).
import assert from "node:assert/strict";
import test from "node:test";

import { HttpError } from "../src/security.mjs";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { PluginService } from "../src/pluginService.mjs";

/** A database whose shared project lock is refused for the first `busyFor` asks. */
function lockedDatabase(busyFor,nativeBusyFor=0,summaryBusyFor=0) {
  const state = { asked: 0, nativeAsked:0, summariesAsked:0, transactions: 0, inserted: 0 };
  const database = {
    state,
    async transaction(work) {
      state.transactions += 1;
      return work({
        async query(sql) {
          // The account's native memory is held by a source cleanup as an exclusive lease row, which admission looks at and never locks.
          if (/to_regclass\('evimed_memory\.native_writer_leases'\)/.test(sql)) return {rows:[{present:true}],rowCount:1};
          if (/FROM evimed_memory\.native_writer_leases/.test(sql)) {
            state.nativeAsked++;return {rows:state.nativeAsked>nativeBusyFor?[]:[{}],rowCount:1};
          }
          if (/to_regclass\('evimed_memory\.native_summary_invalidations'\)/.test(sql)) return { rows: [{ present: true }] };
          if (/FROM evimed_memory\.native_summary_invalidations/.test(sql)) {
            state.summariesAsked++;
            return { rows: state.summariesAsked > summaryBusyFor ? [] : [{}] };
          }
          if (/pg_try_advisory_xact_lock_shared/.test(sql)) {
            state.asked += 1;
            return { rows: [{ acquired: state.asked > busyFor }], rowCount: 1 };
          }
          if (/INSERT INTO evimed_product\.plugin_prompt_admissions/.test(sql)) state.inserted += 1;
          return { rows: [], rowCount: 0 };
        },
      });
    },
  };
  return database;
}

/** @param {any} database @param {number} admissionWaitMs */
function serviceOn(database, admissionWaitMs) {
  const service = new PluginService(database, { admissionWaitMs });
  service.scope = async () => ({});
  return service;
}

const project = { id: "one", userId: "alice" };

test("an admission that meets an apply waits for it to end and then runs, once", async () => {
  const database = lockedDatabase(4);
  const service = serviceOn(database, 5_000);
  let ran = 0;
  const began = Date.now();
  const value = await service.withAdmission(project, async () => { ran += 1; return "started"; });
  assert.equal(value, "started");
  assert.equal(ran, 1, "the operation runs once, after the lock was granted");
  assert.equal(database.state.asked, 5, "four refusals, then the grant");
  assert.ok(Date.now() - began >= 400, "it waited rather than spinning");
});

test("a prompt admission waits the same way, and records its receipt only once admitted", async () => {
  const database = lockedDatabase(2);
  const service = serviceOn(database, 5_000);
  await service.withAdmission(project, async () => "sent", { prompt: true });
  assert.equal(database.state.asked, 3);
  assert.equal(database.state.inserted, 1, "an acceptance receipt for the one admitted attempt, none for the waits");
});

test("an apply that outlasts the wait is refused as before, and the operation never runs", async () => {
  const database = lockedDatabase(Number.POSITIVE_INFINITY);
  const service = serviceOn(database, 300);
  let ran = 0;
  const began = Date.now();
  await assert.rejects(
    service.withAdmission(project, async () => { ran += 1; }),
    (error) => error instanceof HttpError && error.status === 423 && error.code === "plugin_apply_in_progress",
  );
  const waited = Date.now() - began;
  assert.equal(ran, 0);
  assert.ok(waited >= 280 && waited < 2_000, `waited ${waited} ms: the bound, not forever`);
});

test("no wait configured refuses at once, which is what a caller that must not block asks for", async () => {
  const database = lockedDatabase(Number.POSITIVE_INFINITY);
  const service = serviceOn(database, 0);
  await assert.rejects(service.withAdmission(project, async () => {}), { code: "plugin_apply_in_progress" });
  assert.equal(database.state.asked, 1);
  for (const bad of [Number.NaN, undefined]) {
    assert.ok(serviceOn(database, /** @type {any} */ (bad)).admissionWaitMs > 0, "a missing or malformed bound falls back to the default, never to forever or to zero");
  }
});

test("only the lock is waited for: a refusal the operation raises is its own and is not asked again", async () => {
  const database = lockedDatabase(0);
  const service = serviceOn(database, 5_000);
  let ran = 0;
  await assert.rejects(
    service.withAdmission(project, async () => { ran += 1; throw new HttpError(423, "plugin_apply_in_progress", "raised inside"); }),
    { message: "raised inside" },
  );
  assert.equal(ran, 1);
  assert.equal(database.state.asked, 1, "the lock was asked for once");
});

test("a waiter holds no connection while it waits: each ask is its own short transaction", async () => {
  const database = lockedDatabase(3);
  await serviceOn(database, 5_000).withAdmission(project, async () => {});
  // The apply needs pool connections to finish; four waiters inside one long
  // transaction each would have starved it.
  assert.ok(database.state.transactions >= 4);
});


test('a normal prompt waits for account-native source maintenance without duplicating its acceptance receipt',async()=>{
  const database=lockedDatabase(0,2);let ran=0;
  await serviceOn(database,5000).withAdmission(project,async()=>{ran++;},{prompt:true});
  assert.equal(database.state.nativeAsked,3);assert.equal(database.state.inserted,1);assert.equal(ran,1);
});


test('isolation requires four connections and reserves publication, gateway and stop capacity', () => {
  for (const databasePoolMax of [1, 2, 3]) {
    assert.throws(() => new PluginService({}, { runtimeLockIsolation: true, databasePoolMax }), { code: 'database_pool_invalid' });
    assert.doesNotThrow(() => new PluginService({}, { runtimeLockIsolation: false, databasePoolMax }));
    const config = { databasePoolMax, databaseConnectionTimeoutMs: 1000 }, pool = { on: () => {} };
    assert.throws(() => new ControlPlaneDatabase({ ...config, memoryRuntimeLockIsolationEnabled: true }, { pool }), { code: 'database_pool_invalid' });
    assert.doesNotThrow(() => new ControlPlaneDatabase({ ...config, memoryRuntimeLockIsolationEnabled: false }, { pool }));
  }
  for (const databasePoolMax of [4, 5, 6, 10]) {
    const service = new PluginService({}, { runtimeLockIsolation: true, databasePoolMax });
    assert.ok(service.admissionClientLimit <= databasePoolMax - 3);
  }
});

test('a permit retry receives only the remaining admission deadline', async () => {
  const service = serviceOn(lockedDatabase(1), 150), remaining = [];
  service.acquireAdmissionClient = async (_signal, timeoutMs) => { remaining.push(timeoutMs); };
  service.releaseAdmissionClient = () => {};
  await service.withAdmission(project, async () => {});
  assert.equal(remaining.length, 2);
  assert.ok(remaining[0] <= 150 && remaining[1] < 100, JSON.stringify(remaining));
});

test('memory maintenance exceeding the admission bound returns the retryable code without claiming a conversation was deleted', async () => {
  const database = lockedDatabase(0, Infinity), service = serviceOn(database, 120);
  let ran = 0;
  const began = Date.now();
  await assert.rejects(service.withAdmission(project, async () => { ran++; }, { prompt: true }), error => {
    assert.equal(error.status, 409);
    assert.equal(error.code, 'memory_source_cleanup_busy');
    assert.equal(error.definitivelyRejected, true);
    assert.doesNotMatch(error.message, /deleted conversation/);
    return true;
  });
  assert.ok(Date.now() - began >= 100);
  assert.equal(ran, 0); assert.equal(database.state.inserted, 0);
});

test('opening waits for a pending summary rebuild even between exclusive writer leases', async () => {
  const waits = [];
  const database = lockedDatabase(1, 0, 1);
  const service = serviceOn(database, 2_000);
  assert.equal(await service.withAdmission(project, async () => 'opened', {
    waitForSummaries: true, onWait: code => waits.push(code),
  }), 'opened');
  assert.deepEqual(waits, ['plugin_apply_in_progress', 'memory_source_cleanup_busy']);
  assert.equal(database.state.summariesAsked, 2);
});

test('a queued summary that cannot finish within the opening budget keeps the session uncreated', async () => {
  const service = serviceOn(lockedDatabase(0, 0, Infinity), 2_000);
  await assert.rejects(service.withAdmission(project, async () => assert.fail('creation must wait'), {
    waitForSummaries: true, waitMs: 20,
  }), { code: 'memory_source_cleanup_busy' });
});
