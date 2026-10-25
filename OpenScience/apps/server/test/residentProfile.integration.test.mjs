// Review M6 against a real database: the state that says whether a conversation holds the profile, and the decision it drives.
// (What the standing profile was read from, what a lookup counted and what a recall returned were the legacy records engine's, and went
// with it on 2026-10-25; the capsule's entries and the project's card are doubles here, and the engine's own reads are tested with it.)
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { MemorySettingsStore } from "../src/memorySettings.mjs";
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
  store = new MemorySettingsStore({}, { database });
});
after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])", [[owner, other]]);
  await database.close();
});

/** The capsule's profile entries, which the test changes under the profile. */
function capsules(/** @type {any[]} */ facts) {
  const double = { facts, async profileFacts() { return double.facts; }, async lookupCount() { return 0; } };
  return double;
}
const entry = (/** @type {Record<string, any>} */ over = {}) => ({ id: "p1", factKind: "preference", content: "结论先行", updatedAt: "2026-10-20T00:00:00Z", origin: "explicit", ...over });

// Each event a few milliseconds after the one before: the times are kept to the millisecond, and two calls inside one
// millisecond are the same instant, which says neither came first.
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("a conversation's state says what it was last handed and when the kernel compacted it", options, async () => {
  const digest = "a".repeat(64);
  assert.deepEqual(await store.residentState(owner, "prj_state", "ses_state"), { digest: null, deliveredAt: null, compactedAt: null, compactedSince: false, memos: [] });
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
  await store.deleteProjectState(owner, "prj_state");
  assert.deepEqual(await store.residentState(owner, "prj_state", "ses_state"), { digest: null, deliveredAt: null, compactedAt: null, compactedSince: false, memos: [] });
});

test("a real store drives the whole decision: first, unchanged, changed, compacted", options, async () => {
  const user = `${owner}_flow`;
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Flow owner','development')", [user]);
  try {
    const held = capsules([entry()]);
    const profiles = new ResidentProfiles({ config: { memoryProfileMaxRecords: 24 }, store, capsules: held });
    const scope = { projectId: "prj_flow", sessionId: "ses_flow" };

    const first = await profiles.forDispatch(user, scope);
    assert.deepEqual([first.due, first.reason], [true, "first"]);
    assert.match(first.text, /结论先行/);
    await first.delivered();
    const again = await profiles.forDispatch(user, scope);
    assert.deepEqual([again.due, again.reason, again.text], [false, "unchanged", first.text]);

    held.facts = [entry({ content: "结论先行，再给依据" })];
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

test("inside a project a person is in, the card leads the profile: handed once per conversation, again when it moves, and to nobody's turn", options, async () => {
  const user = `resident_card_${randomUUID()}`;
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Resident card','development')", [user]);
  try {
    let rows = [
      { slot: "field", text: "心血管流行病学" }, { slot: "goal", text: "比较两类降糖药的心衰住院风险" },
      { slot: "constraints", text: "周五前出初稿，引用用 AMA 格式" },
    ];
    /** @type {string[][]} */ const asked = [];
    const projectCard = async (/** @type {string} */ userId, /** @type {string} */ projectId) => { asked.push([userId, projectId]); return rows; };
    const profiles = new ResidentProfiles({ config: {}, store, capsules: capsules([entry({ id: "pref_card" })]), projectCard });
    const scope = { projectId: "prj_card", sessionId: "ses_card", attended: true };
    const first = await profiles.forDispatch(user, scope);
    assert.equal(first.reason, "first");
    assert.deepEqual(first.memories[0].id, "card:prj_card");
    assert.equal(first.memories[0].content, "领域：心血管流行病学\n目标：比较两类降糖药的心衰住院风险\n约束：周五前出初稿，引用用 AMA 格式");
    assert.match(first.text, /结论先行/, "the capsule's entries follow the card");
    await first.delivered();
    assert.equal((await profiles.forDispatch(user, scope)).due, false, "once per conversation");
    // A turn nobody is in, and the catch-all project, are handed no card (and the card is not even read for them).
    asked.length = 0;
    assert.doesNotMatch((await profiles.forDispatch(user, { projectId: "prj_card", sessionId: "ses_auto" })).text, /领域/);
    assert.doesNotMatch((await profiles.forDispatch(user, { projectId: "default", sessionId: "ses_default", attended: true })).text, /领域/);
    assert.deepEqual(asked, []);
    // The card moves on: the conversation is handed the block again.
    rows = [...rows, { slot: "stage", text: "数据清洗完成，进入分析" }];
    const moved = await profiles.forDispatch(user, scope);
    assert.deepEqual([moved.due, moved.reason], [true, "changed"]);
    assert.match(moved.text, /阶段：数据清洗完成，进入分析/);
  } finally {
    await database.query("DELETE FROM evimed_control.users WHERE id=$1", [user]);
  }
});
