// The occurrences of a script against the real table (2026-10-25): one row per script and run, the recurrence the lesson is counted from (runs and
// conversations inside the window), the sources the distillation reads, and what takes them away — a project's deletion, an account's, a memory reset.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { resetLearnedMemory } from "../src/memoryReset.mjs";
import { migrateProductStore } from "../src/productPersistence.mjs";
import { SCRIPT_LIMITS, ScriptUses, migrateScriptUses } from "../src/scriptLessons.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) {
  const parsed = new URL(url);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured", timeout: 30_000 };
const owner = `script_${randomUUID().replaceAll("-", "")}`;
const stranger = `script_${randomUUID().replaceAll("-", "")}`;
const HASH = "a".repeat(32);
const OTHER = "b".repeat(32);
const NOW = new Date("2026-10-25T12:00:00.000Z");
/** @type {any} */ let database;
/** @type {ScriptUses} */ let uses;

before(async () => {
  if (!url) return;
  database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  await database.migrate();
  await migrateProductStore(database);
  await migrateScriptUses(database);
  for (const id of [owner, stranger]) await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Script uses','development')", [id]);
  for (const project of ["p_one", "p_two"]) await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,$2,'Scripts',1048576)", [owner, project]);
  uses = new ScriptUses({ database, now: () => NOW });
});

after(async () => {
  if (!url) return;
  await database.query("DELETE FROM evimed_control.projects WHERE user_id = $1", [owner]).catch(() => {});
  await database.query("DELETE FROM evimed_control.users WHERE id = ANY($1)", [[owner, stranger]]).catch(() => {});
  await database.close?.();
});

const day = (/** @type {number} */ daysAgo) => new Date(NOW.getTime() - daysAgo * 86_400_000);
const run = (/** @type {string} */ runId, /** @type {string} */ sessionId, /** @type {string | null} */ projectId, /** @type {number} */ daysAgo, /** @type {any[]} */ scripts, scope = "conversation") =>
  ({ runId, sessionId, projectId, scope, at: day(daysAgo), scripts });

test("one row per script and run; the recurrence counts runs and conversations inside the window, newest first, one account at a time", options, async () => {
  assert.equal(await uses.record(owner, run("run_1", "conv_a", "p_one", 1, [{ hash: HASH, source: "print(1)" }])), 1);
  assert.equal(await uses.record(owner, run("run_1", "conv_a", "p_one", 1, [{ hash: HASH, source: "print(1)" }])), 0, "the same script of the same run is one row");
  await uses.record(owner, run("run_2", "conv_a", "p_one", 2, [{ hash: HASH, source: "print(2)" }, { hash: OTHER, source: "print(9)" }]));
  await uses.record(owner, run("run_3", "conv_b", "p_two", 3, [{ hash: HASH, source: "print(3)" }]));
  // Outside the window it is not a recurrence, however many there are; another account's is not this one's.
  await uses.record(owner, run("run_old", "conv_z", "p_two", 120, [{ hash: HASH, source: "print(0)" }]));
  await uses.record(stranger, run("run_s", "conv_s", null, 1, [{ hash: HASH, source: "print(4)" }]));
  const seen = await uses.recurrence(owner, HASH);
  assert.deepEqual([seen.runs, seen.conversations, seen.scope], [3, 2, "conversation"]);
  assert.deepEqual(seen.occurrences.map((entry) => entry.runId), ["run_1", "run_2", "run_3"], "newest first");
  assert.deepEqual((await uses.recurrence(owner, OTHER)).runs, 1);
  assert.deepEqual((await uses.recurrence(stranger, HASH)).runs, 1);
  assert.deepEqual((await uses.recurrence(owner, "c".repeat(32))).runs, 0);
  // The same session id in two projects is two conversations.
  await uses.record(owner, run("run_4", "conv_a", "p_two", 1, [{ hash: OTHER, source: "print(5)" }]));
  assert.equal((await uses.recurrence(owner, OTHER)).conversations, 2);
});

test("the distillation reads the sources of up to three runs, the newest first, and a source is bounded", options, async () => {
  const exemplars = await uses.exemplars(owner, HASH);
  assert.deepEqual(exemplars.map((entry) => [entry.runId, entry.source]), [["run_1", "print(1)"], ["run_2", "print(2)"], ["run_3", "print(3)"]]);
  assert.equal(exemplars.length <= SCRIPT_LIMITS.exemplars, true);
  const big = "x".repeat(SCRIPT_LIMITS.snippetChars + 500);
  await uses.record(owner, run("run_big", "conv_b", "p_two", 0, [{ hash: "d".repeat(32), source: big }]));
  assert.equal((await uses.exemplars(owner, "d".repeat(32)))[0].source.length, SCRIPT_LIMITS.snippetChars);
  await assert.rejects(() => database.query("INSERT INTO evimed_learning.script_uses(user_id,script_hash,run_id,session_id,scope,occurred_at,source) VALUES ($1,$2,'r','s','conversation',now(),$3)", [owner, "e".repeat(32), "y".repeat(20_001)]), /check/i, "the table holds no more than the module keeps");
  await assert.rejects(() => database.query("INSERT INTO evimed_learning.script_uses(user_id,script_hash,run_id,session_id,scope,occurred_at,source) VALUES ($1,'not-a-hash','r','s','conversation',now(),'x')", [owner]), /check/i);
});

test("a project's deletion takes its occurrences, a memory reset takes the account's, and an account's deletion takes the rest", options, async () => {
  await database.query("DELETE FROM evimed_control.projects WHERE user_id=$1 AND id='p_two'", [owner]);
  const after = await uses.recurrence(owner, HASH);
  assert.deepEqual([after.runs, after.conversations], [2, 1], "what was learnt in the deleted project goes with it");
  assert.deepEqual(await resetLearnedMemory(database, owner).then((result) => typeof result.methods), "number");
  assert.equal((await uses.recurrence(owner, HASH)).runs, 0, "a reset asks to forget, and a script seen before it counts for nothing after it");
  assert.equal((await uses.recurrence(stranger, HASH)).runs, 1, "another account's occurrences are not touched");
  await database.query("DELETE FROM evimed_control.users WHERE id=$1", [stranger]);
  assert.equal((await uses.recurrence(stranger, HASH)).runs, 0);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Script uses','development')", [stranger]);
});
