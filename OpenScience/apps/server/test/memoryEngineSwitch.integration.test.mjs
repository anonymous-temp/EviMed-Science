// Moving an account between the memory engines (scripts/ops/memory-engine.mjs): the report first, the migration through the
// engine with its diff read back, the refusal to move an account whose records the native page would not show, and the way back.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { notMigratedBecause, planMigration, runMigration, verifyAgainstWritten } from "../src/nativeMemoryMigration.mjs";
import { NativeMemoryOverlay } from "../src/nativeMemoryOverlay.mjs";
import { NativeMemoryStore } from "../src/nativeMemoryStore.mjs";
import { NativeMemoryWorker } from "../src/nativeMemoryWorker.mjs";
import { OpenVikingClient } from "../src/openVikingClient.mjs";
import { OpenVikingSessions } from "../src/openVikingSessions.mjs";
import { ResearchMemoryStore } from "../src/researchMemory.mjs";
import { migrateResearchMemory } from "../src/researchMemoryPersistence.mjs";
import { parseArguments, switchEngine } from "../../../scripts/ops/memory-engine.mjs";
import { startOpenVikingStub } from "./helpers/openVikingStub.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) { const parsed = new URL(url); assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)); assert.match(parsed.pathname, /evimed_test/); }
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const NOW = new Date("2026-10-13T09:00:00.000Z");

const record = (over) => ({ id: `r_${randomUUID().slice(0, 6)}`, scope: "user", scopeId: "", kind: "preference", key: "k", value: "v", summary: "", origin: "explicit", status: "active",
  sensitive: false, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z", lastConfirmedAt: "2026-09-03T00:00:00.000Z", invalidSince: null, expiresAt: null, ...over });

test("the plan carries active records by kind and project in the person's words, with dates, and counts what it leaves by reason", () => {
  const records = [
    record({ kind: "preference", value: "Replies in Simplified Chinese." }),
    record({ kind: "preference", value: "Tables for comparisons.", lastConfirmedAt: "2026-09-10T00:00:00.000Z" }),
    record({ kind: "project_fact", scope: "project", scopeId: "p1", value: "The trial enrolled 240 patients." }),
    record({ kind: "project_fact", scope: "project", scopeId: "p2", value: "Second project's fact." }),
    record({ kind: "profile", value: "我是一名医院药师，在成都工作。" }),
    record({ kind: "preference", sensitive: true, value: "kept out" }),
    record({ kind: "preference", status: "archived", value: "forgotten" }),
    record({ kind: "preference", status: "superseded", value: "replaced" }),
    record({ kind: "preference", expiresAt: "2026-01-01T00:00:00.000Z", value: "expired" }),
    record({ kind: "run_summary", value: "a run" }),
    record({ kind: "preference", origin: "system", value: "platform's own" }),
    record({ kind: "preference", value: "My phone is 13800138000 and I like tea." }),
  ];
  const plan = planMigration(records, { now: NOW });
  assert.equal(plan.total, 12);
  assert.equal(plan.carried, 6);
  assert.deepEqual(plan.skipped, { sensitive: 1, inactive: 2, expired: 1, kind: 1, system: 1 });
  assert.deepEqual(plan.sessions.map((session) => [session.kind, session.projectId, session.records]), [
    ["preference", null, 3], ["profile", null, 1], ["project_fact", "p1", 1], ["project_fact", "p2", 1],
  ]);
  const preferences = plan.sessions[0].messages[0].text;
  assert.match(preferences, /^These are my preferences/);
  assert.match(preferences, /- Replies in Simplified Chinese\.（2026-09-03）/);
  assert.doesNotMatch(preferences, /13800138000/, "an identifier-shaped span never reaches the engine");
  assert.match(plan.sessions[1].messages[0].text, /^以下是我之前说过/, "the frame follows the language the person wrote in");
  assert.equal(new Set(plan.sessions.map((session) => session.session)).size, 4, "a session name is stable and distinct per kind and project");
  assert.equal(notMigratedBecause(record({ invalidSince: "2026-01-01T00:00:00.000Z" }), NOW.getTime()), "expired");
});

test("a long group is split into messages that each stay under the bound", () => {
  const records = Array.from({ length: 40 }, (_, index) => record({ value: `Preference number ${index} ${"word ".repeat(60)}` }));
  const plan = planMigration(records, { now: NOW });
  assert.ok(plan.sessions[0].messages.length > 1);
  assert.ok(plan.sessions[0].messages.every((message) => message.text.length <= 4_400));
  assert.equal(plan.sessions[0].messages.reduce((total, message) => total + message.recordIds.length, 0), 40);
});

test("verification looks for each statement whole in what the engine wrote, and says which it did not find", () => {
  const statements = [{ id: "a", value: "Replies in Simplified Chinese." }, { id: "b", value: "Tables for comparisons." }];
  const checked = verifyAgainstWritten(statements, ["# Preferences\n- Replies in simplified chinese. (as of 2026-09-03)\n- Short answers first."]);
  assert.deepEqual(checked, { found: ["a"], notFound: ["b"] });
});

test("the arguments are checked: one account, one engine, and a move that cannot leave the records behind", () => {
  assert.deepEqual(parseArguments(["--check"]).check, true);
  assert.throws(() => parseArguments(["--to", "native"]), /--user/);
  assert.throws(() => parseArguments(["--user", "u", "--to", "elsewhere"]), /--to native or --to legacy/);
  assert.throws(() => parseArguments(["--user", "u", "--to", "legacy", "--migrate"]), /for --to native/);
  // Refused by name, whatever it is combined with: rows left in PostgreSQL are read by nothing once the account is native.
  assert.throws(() => parseArguments(["--user", "u", "--to", "native", "--leave-records", "--apply"]), /--leave-records was removed.*always carries/);
  assert.throws(() => parseArguments(["--user", "u", "--to", "native", "--migrate", "--leave-records"]), /--leave-records was removed/);
  assert.equal(parseArguments(["--user", "u", "--to", "native", "--migrate"]).migrate, true, "--migrate is still accepted on a move");
  assert.throws(() => parseArguments(["--bogus"]), /unknown argument/);
});

/** @type {ControlPlaneDatabase} */
let database;
const users = [];
before(async () => {
  if (!url) return;
  database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 4, databaseConnectionTimeoutMs: 5_000 });
  await migrateResearchMemory(database);
});
after(async () => {
  if (!url) return;
  for (const id of users) await database.query("DELETE FROM evimed_control.users WHERE id=$1", [id]);
  await database.close();
});

/** An engine whose extraction writes each bullet of a migration message into a file of the kind it names. */
function migratingExtract({ user, session, messages }) {
  const adds = [];
  const lines = messages.flatMap((message) => String(message.parts?.[0]?.text ?? message.content ?? "").split("\n")).filter((line) => line.startsWith("- "));
  if (lines.length) adds.push({ uri: `viking://user/${user}/memories/preferences/${session}.md`, memory_type: "preferences", after: lines.join("\n") });
  return { adds };
}

async function fixture(t, { extract = migratingExtract, native = true } = {}) {
  const userId = `ms_${randomUUID().slice(0, 8)}`;
  users.push(userId);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Switch test','development')", [userId]);
  const config = { ovNativeMemoryEnabled: native, memoryContextLimit: 8, memoryContextMaxChars: 20_000 };
  const stub = await startOpenVikingStub(t, { extract });
  const sessions = new OpenVikingSessions(new OpenVikingClient({ openVikingUrl: stub.url, openVikingApiKey: stub.apiKey, openVikingAccount: "evimed" }), { timeoutMs: 2_000, fastTimeoutMs: 1_000 });
  const overlay = new NativeMemoryOverlay({ database });
  const researchMemory = new ResearchMemoryStore(config, { database });
  const worker = new NativeMemoryWorker({ config, researchMemory, sessions, overlay });
  // The account existed before the engine did: it is on the legacy path until it is moved.
  await researchMemory.storedMemoryEngine(userId);
  await database.query("UPDATE evimed_memory.settings SET engine='legacy' WHERE user_id=$1", [userId]);
  const deps = { researchMemory, sessions, overlay, worker, enabled: native, planMigration, runMigration, now: () => NOW, sleep: async () => {} };
  const write = (over) => researchMemory.upsertRecord(userId, { scope: "user", scopeId: "", kind: "preference", key: `k.${randomUUID().slice(0, 6)}`, value: "v", summary: "", origin: "explicit", status: "active",
    confidence: 1, importance: 0.5, sensitive: false, ...over }, null);
  return { userId, stub, sessions, overlay, researchMemory, worker, deps, write, store: new NativeMemoryStore({ sessions, overlay }) };
}

test("the report of a move says what will be carried and asks the engine nothing; the account stays where it is", options, async (t) => {
  const { userId, deps, write, stub } = await fixture(t);
  await write({ value: "Replies in Simplified Chinese." });
  for (const migrate of [false, true]) {
    const report = await switchEngine(deps, { user: userId, to: "native", migrate, apply: false });
    assert.equal(report.ok, true);
    assert.equal(report.applied, false);
    assert.equal(report.records.carried, 1);
    assert.equal(report.willMigrate, true, "a move always carries the records, with or without the flag");
    assert.equal(report.sessionsToRun, 1);
  }
  assert.equal(stub.requests.length, 0, "a dry run does not touch the engine");
  assert.equal(await deps.researchMemory.memoryEngine(userId), "legacy");
});

test("a move without --migrate still carries the records over: there is no way to move an account and leave them", options, async (t) => {
  const { userId, deps, write, researchMemory, overlay, store } = await fixture(t);
  await write({ value: "Replies in Simplified Chinese." });
  const moved = await switchEngine(deps, { user: userId, to: "native", migrate: false, apply: true });
  assert.equal(moved.ok, true, JSON.stringify(moved));
  assert.equal(moved.changed, true);
  assert.equal(moved.migration.failed, 0);
  assert.equal(await researchMemory.memoryEngine(userId), "native");
  assert.ok((await overlay.account(userId)).migratedAt, "the account is marked migrated");
  assert.equal((await store.profile(userId)).activeCount, 1, "the engine's file is the page now");
});

test("--migrate replays the records through the engine, reads the diff back, and moves the account only then; the rows stay", options, async (t) => {
  const { userId, deps, write, stub, store, sessions, overlay, researchMemory } = await fixture(t);
  await write({ value: "Replies in Simplified Chinese." });
  await write({ value: "Tables for comparisons.", key: "k.tables" });
  await write({ kind: "project_fact", scope: "project", scopeId: "p_trial", value: "The trial enrolled 240 patients.", key: "k.trial" });
  await write({ value: "Not to be carried", sensitive: true, key: "k.secret" });
  const result = await switchEngine(deps, { user: userId, to: "native", migrate: true, apply: true });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.changed, true);
  assert.equal(result.migration.failed, 0);
  assert.equal(result.migration.groups.length, 2);
  for (const group of result.migration.groups) {
    assert.equal(group.state, "migrated");
    assert.equal(group.foundVerbatim, group.records, "the extraction wrote each record whole");
    assert.deepEqual(group.notFoundVerbatim, []);
  }
  assert.equal(await researchMemory.memoryEngine(userId), "native");
  assert.equal((await researchMemory.listAllRecords(userId)).length, 4, "PostgreSQL's rows are kept for the fallback window");
  assert.ok((await overlay.account(userId)).migratedAt, "the account is marked migrated");
  const messages = stub.sent("POST", "/api/v1/sessions/evimed-migrate-").filter((request) => request.path.endsWith("/messages")).map((request) => JSON.stringify(request.body));
  assert.equal(messages.length, 2);
  assert.ok(messages.every((text) => !text.includes("Not to be carried")), "a sensitive record is not sent");
  const page = await store.profile(userId);
  assert.equal(page.activeCount, 2, "the engine's files are the page now");
  const ledger = await overlay.openCommits({ userId });
  assert.equal(ledger.length, 0, "every migration commit was ingested");
  assert.ok((await sessions.read(userId, page.records[0].uri)).includes("- "));
  // The project's group carried the project: its commit row names it, so the ingest tags the files.
  const projectCommit = [...stub.sessions.keys()].filter((key) => key.includes("evimed-migrate-")).length;
  assert.equal(projectCommit, 2);
  assert.ok((await overlay.projectSessions(userId, "p_trial")).some((name) => name.startsWith("evimed-migrate-")));
});

test("a second run does the groups that are missing and no others; a group that failed keeps the account where it was", options, async (t) => {
  let fail = true;
  const { userId, deps, write, researchMemory, stub } = await fixture(t, {
    extract: (input) => (fail && input.messages.some((message) => String(message.parts?.[0]?.text).includes("Second kind")) ? "fail" : migratingExtract(input)),
  });
  await write({ value: "First kind of thing." });
  await write({ kind: "decision", scope: "project", scopeId: "p1", value: "Second kind of thing.", key: "k.second" });
  const first = await switchEngine(deps, { user: userId, to: "native", migrate: true, apply: true });
  assert.equal(first.ok, false);
  assert.match(first.error, /1 group\(s\) did not finish/);
  assert.equal(await researchMemory.memoryEngine(userId), "legacy", "the account stays where it was");
  assert.deepEqual(first.migration.groups.map((group) => group.state).sort(), ["failed", "migrated"]);
  fail = false;
  const commitsBefore = stub.sent("POST", "/api/v1/sessions/").filter((request) => request.path.endsWith("/commit")).length;
  const second = await switchEngine(deps, { user: userId, to: "native", migrate: true, apply: true });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.deepEqual(second.migration.groups.map((group) => group.state).sort(), ["already_done", "migrated"]);
  assert.equal(stub.sent("POST", "/api/v1/sessions/").filter((request) => request.path.endsWith("/commit")).length - commitsBefore, 1, "only the missing group is committed again");
  assert.equal(await researchMemory.memoryEngine(userId), "native");
});

test("moving back is the row alone, moving to the engine an account is on changes nothing, and the walk finds nobody on both", options, async (t) => {
  const { userId, deps, researchMemory } = await fixture(t);
  const empty = await switchEngine(deps, { user: userId, to: "native", migrate: false, apply: true });
  assert.equal(empty.ok, true, "an account with no records moves without a migration");
  assert.equal((await switchEngine(deps, { user: userId, to: "native", migrate: false, apply: true })).changed, false);
  const back = await switchEngine(deps, { user: userId, to: "legacy", migrate: false, apply: true });
  assert.equal(back.changed, true);
  assert.equal(await researchMemory.memoryEngine(userId), "legacy");
  const walk = await switchEngine(deps, { check: true });
  assert.equal(walk.ok, true);
  assert.ok(walk.check.examined.legacy + walk.check.examined.native >= 1, "the walk says how many accounts it looked at");
  const off = await fixture(t, { native: false });
  const refused = await switchEngine(off.deps, { user: off.userId, to: "native", migrate: false, apply: true });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /does not have/);
  assert.ok(runMigration);
});

test("an account that is already native and was moved without its records is completed by --migrate: report first, then apply, and migrated_at is set", options, async (t) => {
  const { userId, deps, write, researchMemory, overlay, store, stub } = await fixture(t);
  await write({ value: "Replies in Simplified Chinese." });
  await write({ kind: "project_fact", scope: "project", scopeId: "p_trial", value: "The trial enrolled 240 patients.", key: "k.trial" });
  // How the owner's account was moved on 2026-10-13: the engine row changed, nothing carried over.
  await researchMemory.setMemoryEngine(userId, "native");
  assert.equal((await overlay.account(userId)).migratedAt, null);
  assert.equal((await store.profile(userId)).activeCount, 0, "the records are read by nothing");
  const asked = stub.requests.length;

  // Without the flag the account is left alone and the left-behind records are named.
  const plain = await switchEngine(deps, { user: userId, to: "native", migrate: false, apply: true });
  assert.equal(plain.ok, true);
  assert.equal(plain.changed, false);
  assert.equal(plain.recordsLeftBehind.carried, 2);
  assert.match(plain.recordsLeftBehind.hint, /--migrate/);
  assert.equal(stub.requests.length, asked, "the engine was not asked");
  assert.equal((await overlay.account(userId)).migratedAt, null);

  // The report asks the engine nothing.
  const report = await switchEngine(deps, { user: userId, to: "native", migrate: true, apply: false });
  assert.equal(report.ok, true);
  assert.equal(report.from, "native");
  assert.equal(report.records.carried, 2);
  assert.equal(report.willMigrate, true);
  assert.equal(report.sessionsToRun, 2);
  assert.equal(stub.requests.length, asked, "a report does not touch the engine");
  assert.equal((await overlay.account(userId)).migratedAt, null);

  // The apply carries them over and sets migrated_at; the engine row does not move.
  const applied = await switchEngine(deps, { user: userId, to: "native", migrate: true, apply: true });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.migrated, true);
  assert.equal(applied.changed, false);
  assert.equal(applied.migration.failed, 0);
  assert.equal(applied.migration.groups.length, 2);
  assert.ok((await overlay.account(userId)).migratedAt, "migrated_at is set");
  assert.equal(await researchMemory.memoryEngine(userId), "native");
  assert.equal((await store.profile(userId)).activeCount, 2, "the records are on the page now");
  assert.equal((await researchMemory.listAllRecords(userId)).length, 2, "PostgreSQL's rows are kept");

  // And once it is done there is nothing left to complete.
  const commitsBefore = stub.sent("POST", "/api/v1/sessions/").filter((request) => request.path.endsWith("/commit")).length;
  const again = await switchEngine(deps, { user: userId, to: "native", migrate: true, apply: true });
  assert.equal(again.ok, true);
  assert.match(again.note, /nothing is left behind/);
  assert.equal(stub.sent("POST", "/api/v1/sessions/").filter((request) => request.path.endsWith("/commit")).length, commitsBefore);
  const settled = await switchEngine(deps, { user: userId, to: "native", migrate: false, apply: true });
  assert.equal(settled.recordsLeftBehind, undefined);
});

test("a native account with no migratable record has nothing to complete, and a failed group leaves migrated_at empty", options, async (t) => {
  let fail = true;
  const { userId, deps, write, researchMemory, overlay } = await fixture(t, { extract: (input) => (fail ? "fail" : migratingExtract(input)) });
  await researchMemory.setMemoryEngine(userId, "native");
  const empty = await switchEngine(deps, { user: userId, to: "native", migrate: true, apply: true });
  assert.equal(empty.ok, true);
  assert.match(empty.note, /holds no record/);
  await write({ value: "Short answers first." });
  const failed = await switchEngine(deps, { user: userId, to: "native", migrate: true, apply: true });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /did not finish; the account stays on native/);
  assert.equal((await overlay.account(userId)).migratedAt, null, "an unfinished migration is not recorded as done");
  fail = false;
  const second = await switchEngine(deps, { user: userId, to: "native", migrate: true, apply: true });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.ok((await overlay.account(userId)).migratedAt);
});
