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
import { PluginService } from "../src/pluginService.mjs";

/** A database whose shared project lock is refused for the first `busyFor` asks. */
function lockedDatabase(busyFor) {
  const state = { asked: 0, transactions: 0, inserted: 0 };
  const database = {
    state,
    async transaction(work) {
      state.transactions += 1;
      return work({
        async query(sql) {
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
