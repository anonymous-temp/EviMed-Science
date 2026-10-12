// Review M6 against a real database: what the standing profile is read from, what a lookup counts, what a recall that is not
// the profile's returns, and the state that says whether a conversation holds the profile.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ResearchMemoryStore } from "../src/researchMemory.mjs";
import { ResidentProfiles } from "../src/residentProfile.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) {
  const parsed = new URL(url);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured", timeout: 120_000 };

const owner = `resident_${randomUUID()}`;
const other = `resident_other_${randomUUID()}`;
/** @type {any} */ let database;
/** @type {any} */ let store;

before(async () => {
  if (!url) return;
  database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 8, databaseConnectionTimeoutMs: 5_000 });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) SELECT id,'Resident owner','development' FROM unnest($1::text[]) AS id", [[owner, other]]);
  store = new ResearchMemoryStore({ memoryContextLimit: 8, memoryContextMaxChars: 20_000 }, { database });
});
after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])", [[owner, other]]);
  await database.close();
});

/** @param {Record<string, any>} overrides */
function record(overrides = {}) {
  return {
    scope: "user", scopeId: "", kind: "preference", key: "pref.x", value: "x", summary: "x", origin: "explicit", status: "active",
    confidence: 1, importance: 0.5, sensitive: false, ...overrides,
  };
}
const keysOf = (/** @type {{ id: string }[]} */ memos, /** @type {Map<string, string>} */ keys) => memos.map((memo) => keys.get(memo.id.replace(/^record:/, "")));

test("the standing profile is the durable kinds in force for the conversation, most important first, at most the cap", options, async () => {
  const keys = new Map();
  const write = async (/** @type {Record<string, any>} */ overrides) => {
    const stored = await store.upsertRecord(owner, record(overrides));
    keys.set(stored.id, overrides.key);
    return stored;
  };
  await write({ key: "pref.low", importance: 0.2 });
  await write({ key: "pref.high", importance: 0.95 });
  await write({ key: "profile.role", kind: "profile", importance: 0.8 });
  await write({ key: "behavior.scripts", kind: "behavior", importance: 0.6 });
  await write({ key: "correction.user", kind: "correction", importance: 0.7 });
  await write({ key: "correction.here", kind: "correction", scope: "project", scopeId: "prj_here", importance: 0.65 });
  await write({ key: "correction.elsewhere", kind: "correction", scope: "project", scopeId: "prj_elsewhere", importance: 0.99 });
  // What is not the profile: an episode, the timeline's summary, what the researcher marked sensitive, what was replaced,
  // what is waiting, what has expired.
  await write({ key: "fact.here", kind: "project_fact", scope: "project", scopeId: "prj_here", importance: 0.99 });
  await write({ key: "run.session.s", kind: "run_summary", scope: "project", scopeId: "prj_here", origin: "system", importance: 0.99 });
  await write({ key: "pref.sensitive", sensitive: true, importance: 0.99 });
  await write({ key: "pref.replaced", status: "superseded", importance: 0.99 });
  await write({ key: "pref.waiting", status: "pending", importance: 0.99 });
  await write({ key: "pref.expired", origin: "inferred", expiresAt: "2020-01-01T00:00:00Z", importance: 0.99 });
  await store.upsertRecord(other, record({ key: "pref.someone_elses", importance: 0.99 }));

  const profile = await store.residentRecords(owner, { projectId: "prj_here", sessionId: "ses_a", limit: 24 });
  assert.deepEqual(keysOf(profile, keys), ["pref.high", "profile.role", "correction.user", "correction.here", "behavior.scripts", "pref.low"],
    "by importance; this project's correction and no other project's; no episode, summary, sensitive, replaced, waiting or expired record; no other account's");
  assert.ok(profile.every((memo) => memo.memoryType === "structured" && memo.origin), "each carries what the block renders");

  const capped = await store.residentRecords(owner, { projectId: "prj_here", limit: 2 });
  assert.deepEqual(keysOf(capped, keys), ["pref.high", "profile.role"]);
  assert.deepEqual(await store.residentRecords(owner, { projectId: "prj_here", limit: 0 }), []);

  const long = await store.upsertRecord(owner, record({ key: "pref.long", value: "长".repeat(2_000), summary: "", importance: 0.99 }));
  const [first] = await store.residentRecords(owner, { projectId: "prj_here", limit: 1, entryChars: 400 });
  assert.equal(first.id, `record:${long.id}`);
  assert.equal([...first.content].length, 400, "one long record cannot take the whole block");
  await store.deleteRecord(owner, long.id);
});

test("a lookup counts what the profile does not carry, by scope, and only what a recall could return", options, async () => {
  const projectId = "prj_counts";
  const write = (/** @type {Record<string, any>} */ overrides) => store.upsertRecord(owner, record(overrides));
  await write({ key: "count.fact_1", kind: "project_fact", scope: "project", scopeId: projectId });
  await write({ key: "count.fact_2", kind: "decision", scope: "project", scopeId: projectId });
  await write({ key: "count.other_project", kind: "project_fact", scope: "project", scopeId: "prj_other_counts" });
  await write({ key: "count.session", kind: "follow_up", scope: "session", scopeId: "ses_counts" });
  await write({ key: "count.other_session", kind: "follow_up", scope: "session", scopeId: "ses_not_this_one" });
  await write({ key: "count.user_level", kind: "decision", scope: "user" });
  await write({ key: "count.summary", kind: "run_summary", scope: "project", scopeId: projectId, origin: "system" });
  await write({ key: "count.sensitive", kind: "project_fact", scope: "project", scopeId: projectId, sensitive: true });
  await write({ key: "count.replaced", kind: "project_fact", scope: "project", scopeId: projectId, status: "superseded" });
  await write({ key: "count.expired", kind: "project_fact", scope: "project", scopeId: projectId, origin: "inferred", expiresAt: "2020-01-01T00:00:00Z" });
  await write({ key: "count.durable", kind: "preference", scope: "user" });

  assert.deepEqual(await store.lookupCounts(owner, { projectId, sessionId: "ses_counts" }), { user: 1, project: 2, session: 1 });
  assert.deepEqual(await store.lookupCounts(owner, { projectId: "prj_empty" }), { user: 1, project: 0, session: 0 });
  assert.deepEqual(await store.lookupCounts(`${owner}_nobody`.slice(0, 60), { projectId }), { user: 0, project: 0, session: 0 });
});

test("the recall tool's reading returns what the question reaches and never pads with the standing profile", options, async () => {
  const user = `${owner}_tool`;
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Tool owner','development')", [user]);
  try {
    await store.upsertRecord(user, record({ key: "pref.tables", value: "证据表用三线表", summary: "三线表", kind: "preference", importance: 0.9 }));
    await store.upsertRecord(user, record({ key: "fact.zetazeta", kind: "project_fact", scope: "project", scopeId: "prj_tool", value: "zetazeta 方案的主要终点是总生存期", summary: "zetazeta 终点" }));
    const standing = await store.relevant(user, "你好", { projectId: "prj_tool" });
    assert.deepEqual(standing.map((memo) => memo.kind), ["preference"], "pushed to a greeting, as the builtin arm always did");
    const lookup = await store.relevant(user, "你好", { projectId: "prj_tool", standing: false });
    assert.deepEqual(lookup, [], "a lookup that reaches nothing is empty, and can say so");
    const reached = await store.relevant(user, "zetazeta 方案的终点", { projectId: "prj_tool", standing: false });
    assert.deepEqual(reached.map((memo) => memo.kind), ["project_fact"], "and one that reaches something returns that and not the profile");
  } finally {
    await database.query("DELETE FROM evimed_control.users WHERE id=$1", [user]);
  }
});

// Each event a few milliseconds after the one before: the times are kept to the millisecond, and two calls inside one
// millisecond are the same instant, which says neither came first.
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("a conversation's state says what it was last handed and when the kernel compacted it", options, async () => {
  const digest = "a".repeat(64);
  assert.deepEqual(await store.residentState(owner, "prj_state", "ses_state"), { digest: null, deliveredAt: null, compactedAt: null, compactedSince: false });
  await store.noteCompaction(owner, "prj_state", "ses_state");
  const compactedFirst = await store.residentState(owner, "prj_state", "ses_state");
  assert.equal(compactedFirst.digest, null, "a conversation never handed the profile has nothing to lose to a compaction");
  assert.ok(compactedFirst.compactedAt);

  await tick();
  await store.noteResidentDelivered(owner, "prj_state", "ses_state", digest);
  const handed = await store.residentState(owner, "prj_state", "ses_state");
  assert.equal(handed.digest, digest);
  assert.ok(Date.parse(handed.deliveredAt) >= Date.parse(compactedFirst.compactedAt));
  assert.equal(handed.compactedSince, false, "a hand-over after the compaction puts the profile back in the history");
  await tick();
  await store.noteCompaction(owner, "prj_state", "ses_state");
  const compacted = await store.residentState(owner, "prj_state", "ses_state");
  assert.ok(Date.parse(compacted.compactedAt) >= Date.parse(handed.deliveredAt), "the compaction came after the hand-over");
  assert.equal(compacted.compactedSince, true);
  assert.equal(compacted.digest, digest);

  await assert.rejects(store.residentState(owner, "prj_state", "../bad"), { code: "memory_session_invalid" });
  await assert.rejects(store.noteResidentDelivered(owner, "prj_state", "ses_state", "not a digest"), { code: "memory_payload_invalid" });
  // Another account's conversation of the same name is its own.
  assert.equal((await store.residentState(other, "prj_state", "ses_state")).digest, null);

  // The state is the conversation's: it goes with the project.
  await store.deleteProjectMemory(owner, "prj_state");
  assert.deepEqual(await store.residentState(owner, "prj_state", "ses_state"), { digest: null, deliveredAt: null, compactedAt: null, compactedSince: false });
});

test("a real store drives the whole decision: first, unchanged, changed, compacted", options, async () => {
  const user = `${owner}_flow`;
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Flow owner','development')", [user]);
  try {
    const profiles = new ResidentProfiles({ config: { memoryProfileMaxRecords: 24 }, store });
    const scope = { projectId: "prj_flow", sessionId: "ses_flow" };
    const written = await store.upsertRecord(user, record({ key: "pref.flow", value: "结论先行", summary: "结论先行" }));

    const first = await profiles.forDispatch(user, scope);
    assert.deepEqual([first.due, first.reason], [true, "first"]);
    assert.match(first.text, /结论先行/);
    await first.delivered();
    const again = await profiles.forDispatch(user, scope);
    assert.deepEqual([again.due, again.reason, again.text], [false, "unchanged", first.text]);

    // A project that wrote an episode is not a profile that changed: the line beside it counts it, the digest does not.
    await store.upsertRecord(user, record({ key: "fact.flow", kind: "project_fact", scope: "project", scopeId: "prj_flow", value: "队列 500 人", summary: "队列" }));
    const withEpisode = await profiles.forDispatch(user, scope);
    assert.deepEqual([withEpisode.due, withEpisode.reason], [false, "unchanged"]);
    assert.match(withEpisode.text, /本项目记忆 1 条/);

    await store.upsertRecord(user, record({ key: "pref.flow", value: "结论先行，再给依据", summary: "结论先行，再给依据" }), null, { expectedVersion: written.version });
    const changed = await profiles.forDispatch(user, scope);
    assert.deepEqual([changed.due, changed.reason], [true, "changed"]);
    await changed.delivered();

    await tick();
    await store.noteCompaction(user, scope.projectId, scope.sessionId);
    const compacted = await profiles.forDispatch(user, scope);
    assert.deepEqual([compacted.due, compacted.reason], [true, "compacted"]);
    await compacted.delivered();
    assert.equal((await profiles.forDispatch(user, scope)).due, false);

    // The researcher's pause is read from the real settings.
    await store.updateSettings(user, { recallPaused: true });
    assert.deepEqual([(await profiles.forDispatch(user, scope)).text, (await profiles.forDispatch(user, scope)).reason], ["", "paused"]);
  } finally {
    await database.query("DELETE FROM evimed_control.users WHERE id=$1", [user]);
  }
});
