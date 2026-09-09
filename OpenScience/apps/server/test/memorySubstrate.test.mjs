// The recall port, and the two properties that make it safe to switch.
//
// One: the index decides *which* records are relevant and nothing else. Every
// piece of text that reaches a prompt is read back from the authoritative
// store, so an index holding a deleted, edited, sensitive or out-of-scope
// record cannot put it in front of the model.
//
// Two: an index is an optimisation. When it is unreachable the recall degrades
// to the term matcher rather than failing, because the alternative is an
// outage in answering caused by a component that holds no original data.
import assert from "node:assert/strict";
import test from "node:test";

import {
  memoryUri,
  openVikingPeerId,
  openVikingUserId,
  parseMemoryUri,
  recallTargets,
} from "../src/openVikingClient.mjs";
import { MEMORY_INDEX_PROVIDERS, MemorySubstrate } from "../src/memorySubstrate.mjs";

const USER = "usr_alice";
const PROJECT = "prj_kidney";
const SESSION = "ses_one";

function record(overrides = {}) {
  return {
    id: "rec1",
    scope: "user",
    scopeId: "",
    kind: "preference",
    key: "tone",
    value: "Prefers tables over prose.",
    summary: "Reporting preference",
    origin: "inferred",
    status: "active",
    confidence: 0.8,
    importance: 0.6,
    sensitive: false,
    expiresAt: "",
    updatedAt: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}

/** A research-memory service that records what was asked of it. */
function fakeMemos(records, { memos = [] } = {}) {
  const byId = new Map(records.map((row) => [row.id, row]));
  const calls = { getRecord: [], relevant: 0, list: 0 };
  return {
    calls,
    async getRecord(_userId, id) {
      calls.getRecord.push(id);
      const found = byId.get(id);
      if (!found) {
        const error = new Error("Memory not found.");
        error.code = "memory_not_found";
        throw error;
      }
      return found;
    },
    async listAllRecords() {
      return records;
    },
    async list() {
      calls.list += 1;
      return memos;
    },
    async relevant() {
      calls.relevant += 1;
      return [{ id: "fallback", content: "term matcher answered", memoryType: "structured" }];
    },
  };
}

/** An index that nominates the ids it was told to, in order. */
function fakeIndex(nominations, { fail = null } = {}) {
  const calls = { find: [], remove: [], write: [] };
  return {
    calls,
    configured: true,
    async status() {
      return { configured: true, connected: true, code: null };
    },
    async find(userId, query, options) {
      calls.find.push({ userId, query, options });
      if (fail) throw fail;
      return nominations;
    },
    async write(userId, uri, content) {
      calls.write.push({ uri, content });
      return { ok: true };
    },
    async remove(userId, uri, options) {
      calls.remove.push({ uri, options });
      return true;
    },
  };
}

function hit(uri, score) {
  return { uri, score, content: "whatever the index cached", level: 2 };
}

const openVikingConfig = { memoryIndexProvider: "openviking", memosContextLimit: 8, memosContextMaxChars: 20_000 };

test("a deployment that selects nothing keeps the term matcher, unchanged", async () => {
  const memos = fakeMemos([]);
  const substrate = new MemorySubstrate({}, { memos });
  assert.equal(substrate.provider, "builtin");
  assert.equal(substrate.active, false);
  const recalled = await substrate.recall(USER, "kidney outcomes", { projectId: PROJECT });
  assert.equal(memos.calls.relevant, 1, "the builtin provider must go through the research-memory client");
  assert.deepEqual(recalled.map((row) => row.id), ["fallback"]);
});

test("an unknown provider name falls back rather than composing a broken deployment", () => {
  const substrate = new MemorySubstrate({ memoryIndexProvider: "not-a-provider" }, { memos: fakeMemos([]) });
  assert.equal(substrate.provider, "builtin");
  assert.deepEqual([...MEMORY_INDEX_PROVIDERS], ["builtin", "openviking"]);
});

test("the index orders the recall and the store supplies every word of it", async () => {
  const records = [
    record({ id: "rec1", value: "Prefers tables over prose." }),
    record({ id: "rec2", kind: "analysis", value: "Empagliflozin slowed eGFR decline.", summary: "" }),
  ];
  const memos = fakeMemos(records);
  const index = fakeIndex([
    hit(memoryUri(USER, { scope: "user", scopeId: "", kind: "analysis", recordId: "rec2" }), 0.9),
    hit(memoryUri(USER, { scope: "user", scopeId: "", kind: "preference", recordId: "rec1" }), 0.4),
  ]);
  const substrate = new MemorySubstrate(openVikingConfig, { memos, openViking: index });
  assert.equal(substrate.active, true);

  const recalled = await substrate.recall(USER, "kidney outcomes", { projectId: PROJECT, sessionId: SESSION });

  assert.equal(index.calls.find.length, 1, "the index was never asked; this test would pass on a broken provider");
  assert.equal(memos.calls.relevant, 0, "the term matcher must not also run when an index answered");
  assert.deepEqual(recalled.map((row) => row.id), ["record:rec2", "record:rec1"]);
  // The content is the store's, not the index's cached copy.
  assert.equal(recalled[0].content, "Empagliflozin slowed eGFR decline.");
  assert.ok(recalled.every((row) => row.content !== "whatever the index cached"));
});

test("a nomination the store no longer has is dropped, not guessed at", async () => {
  const memos = fakeMemos([record({ id: "rec1" })]);
  const index = fakeIndex([
    hit(memoryUri(USER, { scope: "user", scopeId: "", kind: "analysis", recordId: "deleted" }), 0.99),
    hit(memoryUri(USER, { scope: "user", scopeId: "", kind: "preference", recordId: "rec1" }), 0.5),
  ]);
  const substrate = new MemorySubstrate(openVikingConfig, { memos, openViking: index });
  const recalled = await substrate.recall(USER, "anything", {});
  assert.deepEqual(recalled.map((row) => row.id), ["record:rec1"]);
});

test("a stale index cannot recall what the record itself refuses", async () => {
  const now = Date.now();
  const records = [
    record({ id: "sensitive", sensitive: true }),
    record({ id: "expired", expiresAt: new Date(now - 60_000).toISOString() }),
    record({ id: "superseded", status: "superseded" }),
    record({ id: "elsewhere", scope: "project", scopeId: "prj_other" }),
    record({ id: "mine", scope: "project", scopeId: PROJECT, value: "This project's fact." }),
  ];
  const memos = fakeMemos(records);
  const index = fakeIndex(records.map((row, position) =>
    hit(memoryUri(USER, { scope: "user", scopeId: "", kind: "preference", recordId: row.id }), 1 - position / 10)));
  const substrate = new MemorySubstrate(openVikingConfig, { memos, openViking: index });

  const recalled = await substrate.recall(USER, "anything", { projectId: PROJECT });

  assert.deepEqual(recalled.map((row) => row.id), ["record:mine"]);
});

test("an index that is down degrades the recall instead of failing the run", async () => {
  const memos = fakeMemos([]);
  const failure = Object.assign(new Error("gone"), { code: "memory_index_unavailable" });
  const substrate = new MemorySubstrate(openVikingConfig, { memos, openViking: fakeIndex([], { fail: failure }) });

  const recalled = await substrate.recall(USER, "anything", {});

  assert.deepEqual(recalled.map((row) => row.id), ["fallback"]);
  assert.equal(memos.calls.relevant, 1);
  assert.equal(substrate.lastError, "memory_index_unavailable", "a silent fallback is an outage nobody can see");
});

test("an operator who would rather see the failure gets it", async () => {
  const failure = Object.assign(new Error("gone"), { code: "memory_index_unavailable" });
  const substrate = new MemorySubstrate(
    { ...openVikingConfig, memoryIndexStrict: true },
    { memos: fakeMemos([]), openViking: fakeIndex([], { fail: failure }) },
  );
  await assert.rejects(() => substrate.recall(USER, "anything", {}), /gone/);
});

test("the profile keeps at most half the budget, whichever provider ranked it", async () => {
  // Four durable memories score above one episodic match. Without the shared
  // budget the profile fills the whole prompt and the memory that answers this
  // particular question never arrives.
  const records = [
    record({ id: "d1", kind: "preference", value: "one" }),
    record({ id: "d2", kind: "profile", value: "two" }),
    record({ id: "d3", kind: "behavior", value: "three" }),
    record({ id: "d4", kind: "correction", value: "four" }),
    record({ id: "e1", kind: "analysis", value: "the answer" }),
  ];
  const memos = fakeMemos(records);
  const index = fakeIndex(records.map((row, position) =>
    hit(memoryUri(USER, { scope: "user", scopeId: "", kind: row.kind, recordId: row.id }), 1 - position / 100)));
  const substrate = new MemorySubstrate(
    { ...openVikingConfig, memosContextLimit: 4 },
    { memos, openViking: index },
  );

  const recalled = await substrate.recall(USER, "anything", {});

  // Two durable slots out of four, so two of the four durable memories are
  // left behind even though they outscored the episodic one — and the episodic
  // one, which is the memory that answers the question, gets in.
  assert.equal(recalled.filter((row) => row.kind === "analysis").length, 1,
    "the episodic match was crowded out; the budget is not shared");
  assert.equal(recalled.filter((row) => ["preference", "profile", "behavior", "correction"].includes(row.kind)).length, 2);
  assert.equal(recalled.length, 3, "nothing else was available to fill the remaining slot");
});

test("forgetting a project deletes its subtree, and says whether it did", async () => {
  const index = fakeIndex([]);
  const substrate = new MemorySubstrate(openVikingConfig, { memos: fakeMemos([]), openViking: index });

  await substrate.forgetProject(USER, PROJECT);

  assert.equal(index.calls.remove.length, 1);
  const [call] = index.calls.remove;
  assert.equal(call.options.recursive, true);
  assert.ok(call.uri.includes(openVikingPeerId(PROJECT)), "the delete must name this project's subtree");
  assert.ok(call.uri.includes(openVikingUserId(USER)));
});

test("a deployment on the term matcher has nothing to forget and does not pretend to", async () => {
  const index = fakeIndex([]);
  const substrate = new MemorySubstrate({}, { memos: fakeMemos([]), openViking: index });
  assert.equal(await substrate.forgetProject(USER, PROJECT), false);
  assert.equal(index.calls.remove.length, 0);
});

test("a rebuild publishes what may be recalled and skips what may not", async () => {
  const records = [
    record({ id: "ok1" }),
    record({ id: "secret", sensitive: true }),
    record({ id: "pending", status: "pending" }),
    record({ id: "blank", value: "", summary: "" }),
  ];
  const index = fakeIndex([]);
  const substrate = new MemorySubstrate(openVikingConfig, { memos: fakeMemos(records), openViking: index });

  const result = await substrate.rebuild(USER);

  assert.deepEqual(result, { written: 1, skipped: 3 });
  assert.equal(index.calls.write.length, 1);
  assert.ok(index.calls.write[0].uri.endsWith("/preference/ok1.md"));
});

test("a written URI reads back as the record it was written for", () => {
  const cases = [
    { scope: "user", scopeId: "", kind: "preference", recordId: "rec1" },
    { scope: "project", scopeId: PROJECT, kind: "analysis", recordId: "rec2" },
    { scope: "session", scopeId: SESSION, kind: "run_summary", recordId: "rec3" },
  ];
  for (const input of cases) {
    const parsed = parseMemoryUri(memoryUri(USER, input));
    assert.ok(parsed, `${input.scope} did not round trip`);
    assert.equal(parsed.scope, input.scope);
    assert.equal(parsed.kind, input.kind);
    assert.equal(parsed.recordId, input.recordId);
  }
  // A path from the server's own extraction names no record of ours.
  assert.equal(parseMemoryUri("viking://user/u-abc/memories/preferences/tone.md"), null);
  assert.equal(parseMemoryUri(""), null);
});

test("a recall searches this user, this project and this session, and nothing else", () => {
  const targets = recallTargets(USER, { projectId: PROJECT, sessionId: SESSION });
  assert.equal(targets.length, 3);
  assert.ok(targets.every((uri) => uri.startsWith(`viking://user/${openVikingUserId(USER)}/memories/evimed`)));
  assert.ok(targets.some((uri) => uri.endsWith(`/project/${openVikingPeerId(PROJECT)}`)));
  // Without a project there is no project subtree to search, rather than a
  // subtree named after nothing.
  assert.deepEqual(recallTargets(USER, {}).length, 1);
});

test("one user's identity never collides with another's, and never leaks the id", () => {
  assert.notEqual(openVikingUserId("usr_a"), openVikingUserId("usr_b"));
  assert.equal(openVikingUserId(USER), openVikingUserId(USER));
  assert.ok(!openVikingUserId(USER).includes(USER));
  assert.match(openVikingUserId(USER), /^u-[a-f0-9]{24}$/);
  assert.match(openVikingPeerId(PROJECT), /^p-[a-f0-9]{24}$/);
});
