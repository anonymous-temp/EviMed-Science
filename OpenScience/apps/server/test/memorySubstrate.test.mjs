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

/** A research-memory store that records what was asked of it. */
function fakeStore(records, { memos = [] } = {}) {
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

/** An index that nominates the ids it was told to, in order. `failWrite` is
 *  given the URI and returns an error for the writes that must fail, which is
 *  how the one failure mode a rebuild actually meets — a slow embedding answered
 *  with 504 after the content was written — is reproduced for one record. */
function fakeIndex(nominations, { fail = null, failWrite = null } = {}) {
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
    async write(userId, uri, content, options) {
      calls.write.push({ uri, content, options });
      const refusal = failWrite?.(uri);
      if (refusal) throw refusal;
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

const openVikingConfig = { memoryIndexProvider: "openviking", memoryContextLimit: 8, memoryContextMaxChars: 20_000 };

test("a deployment that selects nothing keeps the term matcher, unchanged", async () => {
  const store = fakeStore([]);
  const substrate = new MemorySubstrate({}, { store });
  assert.equal(substrate.provider, "builtin");
  assert.equal(substrate.active, false);
  const recalled = await substrate.recall(USER, "kidney outcomes", { projectId: PROJECT });
  assert.equal(store.calls.relevant, 1, "the builtin provider must go through the research-memory store");
  assert.deepEqual(recalled.map((row) => row.id), ["fallback"]);
});

test("a researcher who paused recall, for the account or for this project, is handed no memories", async () => {
  // 2026-09-16 review, M4④. Checked before either path, so the switch holds
  // whichever index is serving.
  for (const settings of [
    { learningPaused: false, recallPaused: true, pausedProjects: [] },
    { learningPaused: false, recallPaused: false, pausedProjects: [PROJECT] },
  ]) {
    const store = { ...fakeStore([]), configured: true, settings: async () => settings };
    const substrate = new MemorySubstrate({}, { store });
    assert.deepEqual(await substrate.recall(USER, "kidney outcomes", { projectId: PROJECT }), []);
    assert.equal(store.calls.relevant, 0, "a paused recall must not reach the store's matcher");
  }
  const elsewhere = { ...fakeStore([]), configured: true, settings: async () => ({ learningPaused: false, recallPaused: false, pausedProjects: ["another-project"] }) };
  const substrate = new MemorySubstrate({}, { store: elsewhere });
  assert.equal((await substrate.recall(USER, "kidney outcomes", { projectId: PROJECT })).length, 1, "pausing one project leaves the others alone");
  const learningOnly = { ...fakeStore([]), configured: true, settings: async () => ({ learningPaused: true, recallPaused: false, pausedProjects: [] }) };
  assert.equal((await new MemorySubstrate({}, { store: learningOnly }).recall(USER, "kidney outcomes", { projectId: PROJECT })).length, 1,
    "pausing learning is not pausing recall");
});

test("an unknown provider name falls back rather than composing a broken deployment", () => {
  const substrate = new MemorySubstrate({ memoryIndexProvider: "not-a-provider" }, { store: fakeStore([]) });
  assert.equal(substrate.provider, "builtin");
  assert.deepEqual([...MEMORY_INDEX_PROVIDERS], ["builtin", "openviking"]);
});

test("the index orders the recall and the store supplies every word of it", async () => {
  const records = [
    record({ id: "rec1", value: "Prefers tables over prose." }),
    record({ id: "rec2", kind: "analysis", value: "Empagliflozin slowed eGFR decline.", summary: "" }),
  ];
  const store = fakeStore(records);
  const index = fakeIndex([
    hit(memoryUri(USER, { scope: "user", scopeId: "", kind: "analysis", recordId: "rec2" }), 0.9),
    hit(memoryUri(USER, { scope: "user", scopeId: "", kind: "preference", recordId: "rec1" }), 0.4),
  ]);
  const substrate = new MemorySubstrate(openVikingConfig, { store, openViking: index });
  assert.equal(substrate.active, true);

  const recalled = await substrate.recall(USER, "kidney outcomes", { projectId: PROJECT, sessionId: SESSION });

  assert.equal(index.calls.find.length, 1, "the index was never asked; this test would pass on a broken provider");
  assert.equal(store.calls.relevant, 0, "the term matcher must not also run when an index answered");
  assert.deepEqual(recalled.map((row) => row.id), ["record:rec2", "record:rec1"]);
  // The content is the store's, not the index's cached copy.
  assert.equal(recalled[0].content, "Empagliflozin slowed eGFR decline.");
  assert.ok(recalled.every((row) => row.content !== "whatever the index cached"));
});

/** A reranker that answers with a fixed order of the documents it was given. */
function fakeRerank(order, { fail = false } = {}) {
  const calls = [];
  return {
    calls,
    configured: true,
    async order(query, documents) {
      calls.push({ query, documents });
      if (fail) throw new Error("rerank exploded");
      return order;
    },
  };
}

// The reranker sits between hydration and the budget. Before hydration it would
// score the index's cached copy, and after the budget it could only reorder the
// candidates that had already survived — which is the half a reranker exists to
// change.
test("a configured reranker reorders the hydrated candidates before the budget cuts them", async () => {
  const records = [
    record({ id: "rec1", value: "Prefers tables over prose." }),
    record({ id: "rec2", kind: "analysis", value: "Empagliflozin slowed eGFR decline.", summary: "" }),
  ];
  const store = fakeStore(records);
  const index = fakeIndex([
    hit(memoryUri(USER, { scope: "user", scopeId: "", kind: "analysis", recordId: "rec2" }), 0.9),
    hit(memoryUri(USER, { scope: "user", scopeId: "", kind: "preference", recordId: "rec1" }), 0.4),
  ]);
  const rerank = fakeRerank([1, 0]);
  const substrate = new MemorySubstrate(openVikingConfig, { store, openViking: index, rerank });

  const recalled = await substrate.recall(USER, "kidney outcomes", { projectId: PROJECT, sessionId: SESSION });

  assert.equal(rerank.calls.length, 1, "the reranker was never asked; this test would pass with no reranker at all");
  assert.ok(rerank.calls[0].documents[0].includes("Empagliflozin"),
    "the reranker must score the store's text, not the index's cached copy");
  assert.deepEqual(recalled.map((row) => row.id), ["record:rec1", "record:rec2"],
    "the reranker's order must replace the vector order, which put rec2 first");
});

test("a reranker that fails leaves the vector order rather than the recall", async () => {
  const records = [record({ id: "rec1" }), record({ id: "rec2", kind: "analysis", summary: "" })];
  const store = fakeStore(records);
  const index = fakeIndex([
    hit(memoryUri(USER, { scope: "user", scopeId: "", kind: "analysis", recordId: "rec2" }), 0.9),
    hit(memoryUri(USER, { scope: "user", scopeId: "", kind: "preference", recordId: "rec1" }), 0.4),
  ]);
  const substrate = new MemorySubstrate(openVikingConfig,
    { store, openViking: index, rerank: fakeRerank([1, 0], { fail: true }) });

  const recalled = await substrate.recall(USER, "kidney outcomes", {});

  assert.deepEqual(recalled.map((row) => row.id), ["record:rec2", "record:rec1"]);
  assert.equal(store.calls.relevant, 0, "a failing reranker must not push the recall onto the term matcher");
});

test("an unconfigured reranker is inert, which is what a deployment without a key has", async () => {
  const records = [record({ id: "rec1" }), record({ id: "rec2", kind: "analysis", summary: "" })];
  const index = fakeIndex([
    hit(memoryUri(USER, { scope: "user", scopeId: "", kind: "analysis", recordId: "rec2" }), 0.9),
    hit(memoryUri(USER, { scope: "user", scopeId: "", kind: "preference", recordId: "rec1" }), 0.4),
  ]);
  const rerank = { ...fakeRerank([1, 0]), configured: false };
  const substrate = new MemorySubstrate(openVikingConfig, { store: fakeStore(records), openViking: index, rerank });

  const recalled = await substrate.recall(USER, "kidney outcomes", {});

  assert.equal(rerank.calls.length, 0);
  assert.deepEqual(recalled.map((row) => row.id), ["record:rec2", "record:rec1"]);
});

test("a nomination the store no longer has is dropped, not guessed at", async () => {
  const store = fakeStore([record({ id: "rec1" })]);
  const index = fakeIndex([
    hit(memoryUri(USER, { scope: "user", scopeId: "", kind: "analysis", recordId: "deleted" }), 0.99),
    hit(memoryUri(USER, { scope: "user", scopeId: "", kind: "preference", recordId: "rec1" }), 0.5),
  ]);
  const substrate = new MemorySubstrate(openVikingConfig, { store, openViking: index });
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
  const store = fakeStore(records);
  const index = fakeIndex(records.map((row, position) =>
    hit(memoryUri(USER, { scope: "user", scopeId: "", kind: "preference", recordId: row.id }), 1 - position / 10)));
  const substrate = new MemorySubstrate(openVikingConfig, { store, openViking: index });

  const recalled = await substrate.recall(USER, "anything", { projectId: PROJECT });

  assert.deepEqual(recalled.map((row) => row.id), ["record:mine"]);
});

test("an index that is down degrades the recall instead of failing the run", async () => {
  const store = fakeStore([]);
  const failure = Object.assign(new Error("gone"), { code: "memory_index_unavailable" });
  const substrate = new MemorySubstrate(openVikingConfig, { store, openViking: fakeIndex([], { fail: failure }) });

  const recalled = await substrate.recall(USER, "anything", {});

  assert.deepEqual(recalled.map((row) => row.id), ["fallback"]);
  assert.equal(store.calls.relevant, 1);
  assert.equal(substrate.lastError, "memory_index_unavailable", "a silent fallback is an outage nobody can see");
});

test("an operator who would rather see the failure gets it", async () => {
  const failure = Object.assign(new Error("gone"), { code: "memory_index_unavailable" });
  const substrate = new MemorySubstrate(
    { ...openVikingConfig, memoryIndexStrict: true },
    { store: fakeStore([]), openViking: fakeIndex([], { fail: failure }) },
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
  const store = fakeStore(records);
  const index = fakeIndex(records.map((row, position) =>
    hit(memoryUri(USER, { scope: "user", scopeId: "", kind: row.kind, recordId: row.id }), 1 - position / 100)));
  const substrate = new MemorySubstrate(
    { ...openVikingConfig, memoryContextLimit: 4 },
    { store, openViking: index },
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
  const substrate = new MemorySubstrate(openVikingConfig, { store: fakeStore([]), openViking: index });

  await substrate.forgetProject(USER, PROJECT);

  assert.equal(index.calls.remove.length, 1);
  const [call] = index.calls.remove;
  assert.equal(call.options.recursive, true);
  assert.ok(call.uri.includes(openVikingPeerId(PROJECT)), "the delete must name this project's subtree");
  assert.ok(call.uri.includes(openVikingUserId(USER)));
});

test("a deployment on the term matcher has nothing to forget and does not pretend to", async () => {
  const index = fakeIndex([]);
  const substrate = new MemorySubstrate({}, { store: fakeStore([]), openViking: index });
  assert.equal(await substrate.forgetProject(USER, PROJECT), false);
  assert.equal(index.calls.remove.length, 0);
});

// Two score spaces in one sort. The index answers with cosine similarity,
// where a good hit is about 0.6; the note matcher answers with a count of
// matched query terms, where one matched word is 1.0. Compared directly, a
// handful of notes mentioning one word of the question takes the whole budget
// and the researcher's structured profile never reaches the prompt — silently,
// and only on the provider this stack now selects by default.
test("a note that shares a word with the question cannot crowd out every memory the index found", async () => {
  const records = [0, 1, 2, 3].map((n) => record({
    id: `rec${n}`, key: `topic.${n}`, value: `Structured memory ${n} about metformin dosing.`,
    updatedAt: `2026-09-0${n + 1}T00:00:00Z`,
  }));
  const notes = [0, 1, 2, 3, 4, 5, 6, 7].map((n) => ({
    id: `note${n}`, content: "a passing note that mentions metformin", pinned: false,
    updatedAt: `2026-08-0${n + 1}T00:00:00Z`,
  }));
  const index = fakeIndex(records.map((row, n) => hit(
    memoryUri(USER, { scope: "user", scopeId: "", kind: "preference", recordId: row.id }), 0.61 - n * 0.02)));
  const substrate = new MemorySubstrate(openVikingConfig, {
    store: fakeStore(records, { memos: notes }), openViking: index,
  });

  const recalled = await substrate.recall(USER, "metformin dosing", {});
  const kinds = recalled.map((row) => row.memoryType);
  assert.ok(kinds.includes("structured"), `the index's hits were crowded out entirely: ${kinds.join(",")}`);
  assert.ok(kinds.filter((kind) => kind === "structured").length >= 3,
    `the best records must compete with the best notes, not lose to all of them: ${kinds.join(",")}`);
  assert.ok(kinds.includes("manual"), "and a matching note must still be able to reach the prompt");
});

// Ten attempts spread over about five minutes of backoff, which an ordinary
// restart of the index outruns. Without a reconcile, the job that lost that
// race stays failed for ever — and for a deleted record that means the index
// keeps the text the researcher asked to be forgotten.
test("an index job that failed while the index was down is put back in the queue", async () => {
  const asked = [];
  const jobs = { async rearm(kind, options) { asked.push([kind, options]); return 2; } };
  const substrate = new MemorySubstrate(openVikingConfig, {
    store: fakeStore([]), openViking: fakeIndex([]), jobs,
  });

  assert.equal(await substrate.reconcileRecords(), 2);
  assert.equal(asked[0][0], "memory-record-index");
  assert.deepEqual(asked[0][1].terminalCodes, ["memory_index_job_invalid", "memory_id_invalid"],
    "a payload that could not name a path will not name one on the eleventh attempt either");
});

test("a term-matcher deployment has no index jobs to reconcile and does not ask", async () => {
  const substrate = new MemorySubstrate({}, {
    store: fakeStore([]),
    jobs: { async rearm() { throw new Error("a builtin deployment must not touch the index queue"); } },
  });
  assert.equal(await substrate.reconcileRecords(), 0);
});

/** The job queue as the worker sees it: one `finish` and what it was told. */
function fakeJobs() {
  const finished = [];
  return {
    finished,
    async finish(userId, id, leaseToken, result) {
      finished.push({ userId, id, leaseToken, result });
      return { id, status: "succeeded", result };
    },
  };
}

function indexJob(overrides = {}) {
  return {
    userId: USER,
    id: "job1",
    leaseToken: "lease1",
    payload: { recordId: "rec1", scope: "user", scopeId: "", memoryKind: "preference", ...overrides },
  };
}

// The gap this closes: before it, a record reached the index only when an
// operator remembered to run the rebuild command. Everything extracted after
// that run was invisible to recall — which a researcher reads as the model
// having forgotten, not as an index being behind.
test("a record's own write reaches the index, without waiting for an operator", async () => {
  const index = fakeIndex([]);
  const jobs = fakeJobs();
  const substrate = new MemorySubstrate(openVikingConfig, {
    store: fakeStore([record({ id: "rec1", version: 4 })]), openViking: index, jobs,
  });

  await substrate.indexRecord(indexJob());

  assert.equal(index.calls.write.length, 1);
  assert.equal(index.calls.write[0].uri, memoryUri(USER, {
    scope: "user", scopeId: "", kind: "preference", recordId: "rec1",
  }));
  assert.deepEqual(index.calls.write[0].options, { wait: true, timeoutSeconds: 5 });
  assert.deepEqual(jobs.finished[0].result, { status: "indexed", recordId: "rec1", version: 4 });
});

test("a memory the researcher deleted loses its copy, addressed from the job", async () => {
  const index = fakeIndex([]);
  const jobs = fakeJobs();
  // The row is gone, so it cannot say where its copy was written. The job's
  // own description of the path is what makes the removal possible at all.
  const substrate = new MemorySubstrate(openVikingConfig, { store: fakeStore([]), openViking: index, jobs });

  await substrate.indexRecord(indexJob({ recordId: "gone", scope: "project", scopeId: PROJECT, memoryKind: "analysis" }));

  assert.equal(index.calls.write.length, 0);
  assert.equal(index.calls.remove.length, 1);
  assert.equal(index.calls.remove[0].uri, memoryUri(USER, {
    scope: "project", scopeId: PROJECT, kind: "analysis", recordId: "gone",
  }));
  assert.deepEqual(index.calls.remove[0].options, { recursive: false });
  assert.deepEqual(jobs.finished[0].result, { status: "removed", recordId: "gone" });
});

// Archiving a memory, marking it sensitive and letting it expire are three
// ways of saying stop using this. All three have to reach the derived copy,
// or "stop" would mean "stop, unless the index answers first".
for (const [name, overrides] of [
  ["archived", { status: "archived" }],
  ["sensitive", { sensitive: true }],
  ["expired", { expiresAt: "2000-01-01T00:00:00Z" }],
  ["emptied", { value: "", summary: "" }],
]) {
  test(`a record that has been ${name} is removed from the index rather than rewritten`, async () => {
    const index = fakeIndex([]);
    const jobs = fakeJobs();
    const substrate = new MemorySubstrate(openVikingConfig, {
      store: fakeStore([record({ id: "rec1", ...overrides })]), openViking: index, jobs,
    });

    await substrate.indexRecord(indexJob());

    assert.equal(index.calls.write.length, 0);
    assert.equal(index.calls.remove.length, 1);
    assert.deepEqual(jobs.finished[0].result, { status: "withheld", recordId: "rec1" });
  });
}

test("a job that outlived the provider is finished, not retried against a component nobody configured", async () => {
  const jobs = fakeJobs();
  const substrate = new MemorySubstrate({ memoryIndexProvider: "builtin" }, {
    store: fakeStore([record({ id: "rec1" })]), openViking: fakeIndex([]), jobs,
  });

  await substrate.indexRecord(indexJob());

  assert.deepEqual(jobs.finished[0].result, { status: "index_disabled", recordId: "rec1" });
});

test("a payload that names no path is refused terminally, not retried ten times", async () => {
  const index = fakeIndex([]);
  const substrate = new MemorySubstrate(openVikingConfig, {
    store: fakeStore([record({ id: "rec1" })]), openViking: index, jobs: fakeJobs(),
  });

  await assert.rejects(
    () => substrate.indexRecord({ userId: USER, id: "job1", leaseToken: "lease1", payload: { recordId: "" } }),
    (error) => error.code === "memory_index_job_invalid" && error.status === 400);
  assert.equal(index.calls.write.length, 0);
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
  const substrate = new MemorySubstrate(openVikingConfig, { store: fakeStore(records), openViking: index });

  const result = await substrate.rebuild(USER);

  assert.deepEqual(result, { written: 1, skipped: 3, failed: 0, removed: 3 });
  // Empty first, then republish. A rebuild that only wrote could converge in
  // one direction: a copy whose record was deleted while the index was
  // unreachable has no event left to remove it and no row to find it from, so
  // the command an operator runs to make the two agree would leave the
  // forgotten text exactly where it was.
  assert.deepEqual(index.calls.remove.map((call) => call.uri.split("/memories/evimed/")[1]),
    ["user", "project", "session"], "the three research subtrees, and not the capsule tree beside them");
  assert.ok(index.calls.remove.every((call) => call.options.recursive));
  assert.equal(index.calls.write.length, 1);
  assert.ok(index.calls.write[0].uri.endsWith("/preference/ok1.md"));
  // An operator's rebuild reports that the index is current. A write that
  // returned before its vector existed would make that report false for a
  // window nobody can measure, so the wait is part of the contract.
  assert.deepEqual(index.calls.write[0].options, { wait: true, timeoutSeconds: 5 });
});

// `wait: true` buys that report at the price of the likeliest failure in the
// whole command: a slow embedding is answered with 504 *after* the content was
// written. Ending the user's rebuild there would leave an index that is mostly
// empty where one more record would have finished it.
test("a rebuild that one record refuses still publishes the rest, and counts the refusal", async () => {
  const records = [record({ id: "ok1" }), record({ id: "slow" }), record({ id: "ok2" })];
  const index = fakeIndex([], {
    failWrite: (uri) => (uri.endsWith("/slow.md")
      ? Object.assign(new Error("the index timed out"), { code: "memory_index_timeout" })
      : null),
  });
  const substrate = new MemorySubstrate(openVikingConfig, { store: fakeStore(records), openViking: index });

  const result = await substrate.rebuild(USER);

  assert.deepEqual(result, { written: 2, skipped: 0, failed: 1, removed: 3, code: "memory_index_timeout" });
  assert.equal(index.calls.write.length, 3, "the rebuild stopped at the refused record instead of continuing");
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

test("a run summary belongs to the timeline: never published to the index, never recalled from it", async () => {
  // It held the platform's own earlier answer, and recall served it as if it
  // were something known about the researcher (2026-09-19 proposal §4.1).
  const summary = record({
    id: "run1", scope: "project", scopeId: PROJECT, kind: "run_summary", key: "run.question.abc",
    value: JSON.stringify({ question: "SGLT2 在 CKD 中的获益", answer: "之前的长篇回答" }), origin: "system",
  });
  const fact = record({ id: "fact1", scope: "project", scopeId: PROJECT, kind: "project_fact", key: "cohort", value: "队列 500 人" });
  const index = fakeIndex([
    hit(memoryUri(USER, { scope: "project", scopeId: PROJECT, kind: "run_summary", recordId: "run1" }), 0.9),
    hit(memoryUri(USER, { scope: "project", scopeId: PROJECT, kind: "project_fact", recordId: "fact1" }), 0.8),
  ]);
  const substrate = new MemorySubstrate(openVikingConfig, { store: fakeStore([summary, fact]), openViking: index });

  const recalled = await substrate.recall(USER, "SGLT2 CKD", { projectId: PROJECT });
  assert.deepEqual(recalled.map((row) => row.id), ["record:fact1"], "an index that still nominates one gets nothing for it");

  const rebuilt = await substrate.rebuild(USER);
  assert.equal(rebuilt.written, 1);
  assert.ok(index.calls.write.every((call) => !call.uri.endsWith("/run1.md")), "and a rebuild publishes no copy of one");
});
