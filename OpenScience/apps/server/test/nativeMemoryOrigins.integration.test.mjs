// Provenance and hygiene of the native overlay (2026-10-25): where each line of a memory file came from beyond the 32 revisions a file
// holds, when a file was last recalled, and the account's type allowlist in the engine.
import assert from "node:assert/strict";
import { test } from "node:test";

import { lineFingerprint } from "../src/nativeMemoryOverlay.mjs";
import { nativeMemoryCounters } from "../src/nativeMemoryMetrics.mjs";
import { OPENVIKING_MEMORY_TYPES } from "../src/openVikingLayout.mjs";
import { nativeIntegration } from "./helpers/nativeFixture.mjs";

const { options, fixture, database } = nativeIntegration();

const OLD_TYPES = ["profile", "preferences", "entities", "corrections", "project_context", "decisions", "follow_ups", "project_facts"];

/** An engine whose profile grows by one line per conversation: line n is written by conversation n. */
function growingProfile(later) {
  return ({ session }) => {
    const f = later();
    const number = Number(/_c(\d+)$/.exec(session)?.[1] ?? 0);
    if (!number) return {};
    const uri = `${f.root}/profile.md`;
    const held = f.stub.files.get(uri);
    const line = `- 第 ${number} 条事实 (as of 2026-10-13)`;
    return held === undefined
      ? { adds: [{ uri, memory_type: "profile", after: `# 用户\n${line}` }] }
      : { updates: [{ uri, memory_type: "profile", before: held, after: `${held}\n${line}` }] };
  };
}

async function growing(t, conversations) {
  /** @type {any} */
  let f;
  f = await fixture(t, { extract: growingProfile(() => f) });
  for (let number = 1; number <= conversations; number += 1) {
    await f.commitConversation(`c${number}`, [{ role: "user", text: `第 ${number} 件事。` }]);
    await f.worker.processCommits({ userId: f.userId });
  }
  return f;
}

test("a line still names the conversation that brought it after the file's 32 revisions have moved past it", options, async (t) => {
  const f = await growing(t, 36);
  const uri = `${f.root}/profile.md`;
  assert.equal((await f.overlay.revisionsOf(f.userId, uri, { limit: 32 })).length, 32, "the window a file's history holds");
  const records = (await f.store.records(f.userId)).filter((record) => record.document);
  assert.equal(records.length, 36);
  const first = records.find((record) => record.value === "第 1 条事实");
  assert.deepEqual(first.evidence.map((item) => item.conversationId), ["session_c1"], "the oldest line, whose revision is out of the window, still has its conversation");
  const last = records.find((record) => record.value === "第 36 条事实");
  assert.deepEqual(last.evidence.map((item) => item.conversationId), ["session_c36"]);
  // One row per line, and the first writer's: a line a later commit restates keeps the conversation that brought it.
  const origins = (await f.overlay.originsOf(f.userId, [uri])).get(uri);
  assert.equal(origins.size, 36);
  assert.equal(origins.get(lineFingerprint("第 1 条事实")).engineSession, "dsh-session_c1");
});

test("a line the person takes out leaves the index, and a file forgotten takes all of its lines", options, async (t) => {
  const f = await growing(t, 3);
  const uri = `${f.root}/profile.md`;
  const target = (await f.store.records(f.userId)).find((record) => record.value === "第 2 条事实");
  await f.store.update(f.userId, target.id, { status: "archived", expectedVersion: target.version });
  const origins = (await f.overlay.originsOf(f.userId, [uri])).get(uri);
  assert.deepEqual([...origins.keys()].sort(), [lineFingerprint("第 1 条事实"), lineFingerprint("第 3 条事实")].sort());
  await f.store.remove(f.userId, (await f.store.records(f.userId))[0].document.id, { keepText: true });
  assert.equal((await f.overlay.originsOf(f.userId, [uri])).size, 0, "nothing is kept of a file that is gone");
});

test("an account whose older revisions were never read into the index has them read once, by the worker, oldest first", options, async (t) => {
  const f = await growing(t, 4);
  const uri = `${f.root}/profile.md`;
  // The state of an account from before the index existed.
  await database().query("DELETE FROM evimed_memory.native_line_origins WHERE user_id=$1", [f.userId]);
  await database().query("UPDATE evimed_memory.native_accounts SET origins_indexed_at=NULL WHERE user_id=$1", [f.userId]);
  assert.equal((await f.overlay.originsOf(f.userId, [uri])).size, 0);
  assert.equal(await f.overlay.originsIndexed(f.userId), false);
  await f.worker.pass();
  const origins = (await f.overlay.originsOf(f.userId, [uri])).get(uri);
  assert.equal(origins.size, 4);
  assert.equal(origins.get(lineFingerprint("第 3 条事实")).engineSession, "dsh-session_c3", "each line has the first commit that brought it");
  assert.equal(await f.overlay.originsIndexed(f.userId), true);
  // Once: a second pass reads nothing again (a line the index lost on purpose stays lost).
  await database().query("DELETE FROM evimed_memory.native_line_origins WHERE user_id=$1", [f.userId]);
  await f.worker.pass();
  assert.equal((await f.overlay.originsOf(f.userId, [uri])).size, 0);
});

test("a platform session's lines say so: an import and a promoted choice are named for what they are, and a line of no conversation names none", options, async (t) => {
  const f = await fixture(t, { extract: ({ session }) => {
    const root = `viking://user/${/** @type {any} */ (f).engineUser}/memories`;
    if (session.startsWith("evimed-import-")) return { adds: [{ uri: `${root}/profile.md`, memory_type: "profile", after: "# 用户\n- 我是心内科医生 (as of 2026-10-13)" }] };
    return {};
  } });
  await f.store.rememberImport(f.userId, { ordinary: ["我是心内科医生"] });
  await f.worker.processCommits({ userId: f.userId });
  const line = (await f.store.records(f.userId)).find((record) => record.document);
  assert.deepEqual(line.evidence.map((item) => [item.sourceType, item.label]), [["import", "从其他 AI 导入"]]);
  assert.equal(line.evidence[0].conversationId, undefined, "no conversation to link to");
});

// ------------------------------------------------------------------------------------------------------- last recalled

test("a recall notes the file: when it last came back and how often, for a file the overlay knows and for no other", options, async (t) => {
  const f = await growing(t, 1);
  const uri = `${f.root}/profile.md`;
  assert.equal((await f.overlay.file(f.userId, uri)).recallCount, 0);
  assert.equal(await f.overlay.noteRecalled(f.userId, [uri, `${f.root}/preferences/never-seen.md`]), 1, "only the file the overlay holds");
  assert.equal(await f.overlay.noteRecalled(f.userId, [uri]), 1);
  const held = await f.overlay.file(f.userId, uri);
  assert.equal(held.recallCount, 2);
  assert.ok(Number.isFinite(Date.parse(held.lastRecalledAt)));
  const record = (await f.store.records(f.userId)).find((entry) => entry.uri === uri);
  assert.equal(record.recallCount, 2, "the page's record carries it, for a later decision; nothing acts on it");
  assert.equal(await f.overlay.noteRecalled(f.userId, []), 0);
});

// ----------------------------------------------------------------------------------------------- the type allowlist

test("an account whose stored settings predate a memory type is rewritten to the deployment's list, with its own learning switch restated", options, async (t) => {
  const f = await fixture(t);
  // An account PATCHed before `observations` and `recent_work` existed holds the old eight: the deployment's default no longer reaches it.
  f.stub.users.get(f.engineUser).memoryTypes = [...OLD_TYPES];
  await f.memorySettings.updateSettings(f.userId, { learningPaused: true });
  f.stub.users.get(f.engineUser).learning = false;
  await f.worker.pass();
  const held = f.stub.users.get(f.engineUser);
  assert.deepEqual([...held.memoryTypes].sort(), [...OPENVIKING_MEMORY_TYPES].sort());
  assert.equal(held.learning, false, "the person's pause is restated, not undone");
  assert.equal(nativeMemoryCounters().policySyncs.rewritten >= 1, true);
  // Checked, found current, and not asked again for six hours in a process.
  const settingsReads = () => f.stub.sent("GET", `/api/v1/admin/accounts/evimed/users/${f.engineUser}/settings`).length;
  const before = settingsReads();
  await f.worker.pass();
  assert.equal(settingsReads(), before, "one look per account per six hours");
  f.advance(7 * 3_600_000);
  await f.worker.pass();
  assert.ok(settingsReads() > before, "and again after");
});

test("an account already on the list is left alone, an unregistered one is looked at again, an engine that cannot say is counted", options, async (t) => {
  const f = await fixture(t);
  await f.worker.pass();
  assert.equal(f.stub.sent("PATCH", "/api/v1/admin/accounts/evimed/users").length, 0, "no write for an account on the list");
  assert.equal(nativeMemoryCounters().policySyncs.current >= 1, true);
  const g = await fixture(t);
  g.stub.users.delete(g.engineUser);
  await g.worker.pass();
  assert.equal(g.stub.sent("PATCH", "/api/v1/admin/accounts/evimed/users").length, 0, "an account the engine does not know has the default");
});

// ------------------------------------------------------------------------------------------------- failures by their own reason

test("an extraction that failed with budget_exhausted is counted in its own bucket, and a rate limit is another", options, async (t) => {
  const f = await fixture(t, { extract: ({ session }) => (session.endsWith("_a") ? { fail: "Extraction output was truncated (budget_exhausted): raise vlm.max_tokens" } : session.endsWith("_b") ? "fail" : {}) });
  await f.commitConversation("a", [{ role: "user", text: "一件事。" }]);
  await f.commitConversation("b", [{ role: "user", text: "另一件事。" }]);
  await f.worker.processCommits({ userId: f.userId });
  const counts = nativeMemoryCounters().extractionFailures;
  assert.equal(counts.budget_exhausted, 1);
  assert.equal(counts.other, 1, "a 429 is no budget of the output");
  assert.equal(counts.quota, 0);
});
