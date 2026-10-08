// Which conversations used a document (N-16): what a finished run's transcript says it consulted. Pure — no store.
import assert from "node:assert/strict";
import test from "node:test";
import { SOURCE_USE_KINDS, nameConversations, sourceIdsInReadPaths, sourceUsesFromMessages, sourceUsesFromSessions } from "../src/sourceUses.mjs";

const A = `src_${"a".repeat(32)}`;
const B = `src_${"b".repeat(32)}`;
const C = `src_${"c".repeat(32)}`;
const derived = (id) => `/workspace/.evimed-knowledge/.evimed-derived/${id}/read-1-job-abc/index.md`;
const tool = (name, input, output = "", extra = {}) => ({ role: "assistant", time: 1_000, parts: [{ type: "tool", tool: name, callId: "c", status: "completed", input, output, ...extra }] });
const searchOutput = (data) => JSON.stringify({ status: "success", summary: "Found", data, warnings: [], next_actions: [] });

test("a source id is read off the two paths a run reads a document at, and only there", () => {
  assert.deepEqual(sourceIdsInReadPaths(derived(A)), [A]);
  assert.deepEqual(sourceIdsInReadPaths(`/workspace/library/${B}/index.md`), [B]);
  assert.deepEqual(sourceIdsInReadPaths(`cat .evimed-knowledge/.evimed-derived/${A}/read-1/index.md | head; sed -n 1,5p library/${B}/index.md`).sort(), [A, B]);
  // Not a document's text: the directory alone names none, and an id in another place is not a read of this document.
  for (const text of [".evimed-knowledge/.evimed-derived/", ".evimed-knowledge/", `notes/${A}.md`, `/workspace/deliverables/${A}/report.md`,
    `/workspace/my-library/${A}/index.md`, `.evimed-derived/src_${"a".repeat(31)}/`, `.evimed-derived/${A}x/`, "", null, undefined, 42]) {
    assert.deepEqual(sourceIdsInReadPaths(text), [], String(text));
  }
});

test("a search hit counts, with the time of the call and how often; a small library's list of files does not", () => {
  const uses = sourceUsesFromMessages([
    tool("mcp__evimed__kb_search", { query: "达比加群" }, searchOutput({ mode: "keyword", hits: [{ sourceId: A, page: 2 }, { sourceId: A, page: 3 }, { sourceId: B }] }), { completedAt: 5_000 }),
    tool("mcp__evimed__kb_search", { query: "again" }, searchOutput({ mode: "keyword", hits: [{ sourceId: A }] }), { completedAt: 9_000 }),
    // The small-library answer: no hits, a list of files to read — an offer, not a use.
    tool("mcp__evimed__kb_search", { query: "x" }, searchOutput({ mode: "small-library", hits: [], files: [{ sourceId: C, path: derived(C) }] }), { completedAt: 7_000 }),
  ]);
  assert.deepEqual(uses.map((use) => [use.sourceId, use.kind, use.count, use.firstUsedAt, use.lastUsedAt]).sort(),
    [[A, "search", 2, 5_000, 9_000], [B, "search", 1, 5_000, 5_000]].sort(), "one entry per document, however many passages of it came back");
});

test("a run that reads the parsed text itself counts, by read, grep or a shell command — which is how every run over a small library works", () => {
  const uses = sourceUsesFromMessages([
    tool("read", { file_path: derived(A), offset: 1, limit: 200 }, "", { completedAt: 2_000 }),
    tool("read", { path: derived(A) }, "", { completedAt: 3_000 }),
    tool("grep", { pattern: "20 mg", path: derived(B) }, "", { completedAt: 4_000 }),
    tool("bash", { command: `cat /workspace/library/${C}/index.md | head -80` }, "", { completedAt: 6_000 }),
    tool("bash", { cmd: `wc -c .evimed-knowledge/.evimed-derived/${B}/read-1/index.md` }, "", { completedAt: 1_500 }),
  ]);
  const by = Object.fromEntries(uses.map((use) => [use.sourceId, use]));
  assert.deepEqual([by[A].kind, by[A].count, by[A].firstUsedAt, by[A].lastUsedAt], ["read", 2, 2_000, 3_000]);
  assert.deepEqual([by[B].count, by[B].firstUsedAt, by[B].lastUsedAt], [2, 1_500, 4_000]);
  assert.deepEqual([by[C].kind, by[C].count], ["read", 1]);
  assert.ok(uses.every((use) => SOURCE_USE_KINDS.includes(use.kind)));
});

test("a search and a read of one document are two kinds of use, and what is not a use is not counted", () => {
  const uses = sourceUsesFromMessages([
    tool("mcp__evimed__kb_search", { query: "q" }, searchOutput({ hits: [{ sourceId: A }] })),
    tool("read", { file_path: derived(A) }),
    // A call that failed or never completed read nothing.
    tool("read", { file_path: derived(B) }, "", { status: "error" }),
    { role: "assistant", time: 1, parts: [{ type: "tool", tool: "read", status: "pending", input: { file_path: derived(B) } }] },
    // Tools that do not read a document by a path; a listing; text that merely says a path.
    tool("ls", { path: ".evimed-knowledge/.evimed-derived/" }),
    tool("glob", { pattern: `.evimed-derived/${B}/*` }),
    tool("write", { file_path: "notes.md", content: derived(B) }),
    { role: "assistant", time: 1, parts: [{ type: "text", text: `I read ${derived(B)}` }] },
    // A search whose answer is not JSON, or has no hits, or names a malformed id.
    tool("mcp__evimed__kb_search", { query: "q" }, "unavailable"),
    tool("mcp__evimed__kb_search", { query: "q" }, searchOutput({ hits: [{ sourceId: "src_short" }, { title: "no id" }, null] })),
  ]);
  assert.deepEqual(uses.map((use) => [use.sourceId, use.kind]).sort(), [[A, "read"], [A, "search"]].sort());
});

test("a call with no time of its own takes the message's, then the one the caller gives", () => {
  const [byMessage] = sourceUsesFromMessages([{ role: "assistant", time: 4_000, parts: [{ type: "tool", tool: "read", status: "completed", input: { file_path: derived(A) } }] }], 99);
  assert.equal(byMessage.firstUsedAt, 4_000);
  const [byCaller] = sourceUsesFromMessages([{ role: "assistant", parts: [{ type: "tool", tool: "read", status: "completed", input: { file_path: derived(A) } }] }], 99);
  assert.equal(byCaller.firstUsedAt, 99);
});

test("the sessions of a run are one run: a delegate that read the document is the run having used it", () => {
  const uses = sourceUsesFromSessions([
    { sessionId: "root", transcript: { messages: [tool("evimed_delegate", { deliverableId: "d1" }, "ok")] } },
    { sessionId: "child", transcript: { messages: [tool("read", { file_path: derived(A) }, "", { completedAt: 8_000 })] } },
    { sessionId: "lost", transcript: null },
  ], 1);
  assert.deepEqual(uses.map((use) => [use.sourceId, use.kind, use.lastUsedAt]), [[A, "read", 8_000]]);
  assert.deepEqual(sourceUsesFromSessions(null), []);
  assert.deepEqual(sourceUsesFromSessions([]), []);
});

test("a conversation is named by its title, else the question that began it, and a deleted one is left out", () => {
  const rows = [{ sessionId: "s1", projectId: "p" }, { sessionId: "s2", projectId: "p" }, { sessionId: "s3", projectId: "p" }, { sessionId: "s4", projectId: "q" }, { sessionId: "s5", projectId: "p" }];
  const ledgers = new Map([["p", [
    { id: "r2", sessionId: "s1", title: "  SGLT2 抑制剂  与心衰", question: "later question" },
    { id: "r1", sessionId: "s1", title: "", question: "the first question" },
    { id: "r4", sessionId: "s2", question: "later turn" },
    { id: "r3", sessionId: "s2", question: "  the question\nthat began it  " },
    { id: "r5", sessionId: "s3", title: "已删除", deleted: true },
    { id: "r6", sessionId: "s5", title: "x".repeat(500) },
  ]]]);
  const named = nameConversations(rows, ledgers);
  assert.deepEqual(named.map((row) => [row.sessionId, row.title === null ? null : row.title.slice(0, 20)]), [
    ["s1", "SGLT2 抑制剂 与心衰"],
    ["s2", "the question that be"],
    // The ledger of project q cannot be read: kept, untitled.
    ["s4", null],
    ["s5", "x".repeat(20)],
  ]);
  assert.equal(named.find((row) => row.sessionId === "s5").title.length, 200);
});

test("a finished run's hook records what its sessions used, skips background work, and never fails the run", async () => {
  const { recordSourceUsesOfRun } = await import("../src/sourceUses.mjs");
  const recorded = [];
  const store = { record: async (input) => { recorded.push(input); return input.uses.length; } };
  const project = { userId: "u1", id: "p1" };
  const run = { id: "run_1", sessionId: "session_1", finishedAt: "2026-10-08T08:00:00.000Z" };
  const sessions = [{ sessionId: "session_1", transcript: { messages: [tool("read", { file_path: derived(A) }), tool("mcp__evimed__kb_search", { query: "q" }, searchOutput({ hits: [{ sourceId: B }] }))] } }];
  assert.equal(await recordSourceUsesOfRun({ sourceUses: store, project, run, sessions }), 2);
  assert.deepEqual([recorded[0].userId, recorded[0].projectId, recorded[0].runId, recorded[0].sessionId], ["u1", "p1", "run_1", "session_1"], "the conversation is the run's own session, not a delegate's");
  assert.deepEqual(recorded[0].uses.map((use) => [use.sourceId, use.kind]).sort(), [[A, "read"], [B, "search"]]);
  // The time of a call with none of its own is when the run finished.
  assert.equal(recorded[0].uses[0].firstUsedAt, 1_000, "a call carries its message's time before the run's");
  // Background work, a deployment with no store, and a run that used nothing record nothing.
  assert.equal(await recordSourceUsesOfRun({ sourceUses: store, project, run, sessions, skip: true }), 0);
  assert.equal(await recordSourceUsesOfRun({ sourceUses: null, project, run, sessions }), 0);
  assert.equal(await recordSourceUsesOfRun({ sourceUses: store, project, run, sessions: [{ sessionId: "s", transcript: { messages: [tool("read", { file_path: "notes.md" })] } }] }), 0);
  assert.equal(recorded.length, 1);
  // A store that fails is reported and is not the run's failure; a report that fails is no failure either.
  const errors = [];
  const failing = { record: async () => { throw Object.assign(new Error("database down"), { code: "db_down" }); } };
  assert.equal(await recordSourceUsesOfRun({ sourceUses: failing, project, run, sessions, onError: (error) => errors.push(error.code) }), 0);
  assert.deepEqual(errors, ["db_down"]);
  assert.equal(await recordSourceUsesOfRun({ sourceUses: failing, project, run, sessions, onError: () => { throw new Error("audit down"); } }), 0);
});
