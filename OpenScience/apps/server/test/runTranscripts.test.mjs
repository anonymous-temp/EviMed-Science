import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collectRunTranscripts,
  persistRunTranscript,
  pruneRunTranscripts,
  readRunTranscript,
  serializeRunTranscript,
  TRANSCRIPT_DIR_NAME,
  TRANSCRIPT_SCHEMA_VERSION,
  transcriptExcerpt,
  transcriptPath,
} from "../src/runTranscripts.mjs";

const CAPTURED_AT = "2026-09-07T04:00:00.000Z";

function message(seq, text) {
  return {
    role: "assistant",
    source: "user",
    seq,
    time: 1_757_000_000_000 + seq,
    turn: 1,
    step: seq,
    parts: [{ type: "text", text }],
    usage: null,
    interrupted: false,
  };
}

function transcript(sessionId, messages, { subagents = [], lastSeq } = {}) {
  return {
    sessionId,
    messages,
    turnEnd: null,
    subagents,
    lastSeq: lastSeq ?? (messages.length ? messages[messages.length - 1].seq : -1),
  };
}

const subagent = (sessionId, capability) => ({
  sessionId,
  parentSessionId: "ses_root",
  label: "subagent",
  capability,
});

/**
 * A runtime whose session reads a test writes by hand.
 *
 * It answers per session id rather than returning one shared transcript,
 * because a fake that answered the same thing for every id would let a
 * collector that never asked for a child look exactly like one that did.
 */
class FakeRuntime {
  constructor(sessions) {
    this.sessions = new Map(Object.entries(sessions));
    this.calls = [];
  }

  async sessionTranscript(project, sessionId, options) {
    this.calls.push({ sessionId, options });
    const answer = this.sessions.get(sessionId);
    if (answer instanceof Error) throw answer;
    if (!answer) {
      const error = new Error("Runtime is not running for session history monitoring.");
      error.code = "runtime_not_running";
      throw error;
    }
    return answer;
  }
}

function unreadable(code = "runtime_session_not_found") {
  const error = new Error("session is gone");
  error.code = code;
  return error;
}

/** A parent that delegated twice, with every session readable through its head sequence. */
function delegatingRun() {
  return new FakeRuntime({
    ses_root: transcript("ses_root", [message(1, "plan the review"), message(2, "delegate")], {
      subagents: [subagent("ses_child_a", "clinical-evidence-synthesis"), subagent("ses_child_b", "source-understanding")],
    }),
    ses_child_a: transcript("ses_child_a", [message(3, "search"), message(4, "quote")]),
    ses_child_b: transcript("ses_child_b", [message(5, "parse the source")]),
  });
}

async function withProject(fn) {
  const rootDir = await realpath(await mkdtemp(path.join(tmpdir(), "os-run-transcripts-")));
  const project = { id: "default", userId: "user_one", rootDir, metaDir: path.join(rootDir, ".openscience") };
  try {
    await fn(project);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

async function readLines(project, runId) {
  const text = await readFile(transcriptPath(project, runId), "utf8");
  const lines = text.split("\n").filter(Boolean);
  return { text, header: JSON.parse(lines[0]), records: lines.slice(1).map((line) => JSON.parse(line)) };
}

test("a run's own session and both of its subagent sessions are collected whole into one complete transcript", async () => {
  await withProject(async (project) => {
    const runtime = delegatingRun();
    const run = { id: "run_complete", sessionId: "ses_root" };

    const sessions = await collectRunTranscripts(runtime, project, run);
    const receipt = await persistRunTranscript({ project, run, sessions, now: new Date(CAPTURED_AT) });
    const { header, records } = await readLines(project, run.id);

    assert.equal(receipt.completeness, "complete");
    assert.deepEqual(receipt.missing, []);
    assert.equal(header.schemaVersion, TRANSCRIPT_SCHEMA_VERSION);
    assert.equal(header.runId, "run_complete");
    assert.equal(header.capturedAt, CAPTURED_AT);
    assert.deepEqual(header.sessions.map((entry) => entry.sessionId), ["ses_root", "ses_child_a", "ses_child_b"]);
    assert.deepEqual(header.sessions.map((entry) => entry.parentSessionId), [null, "ses_root", "ses_root"]);
    assert.deepEqual(header.sessions.map((entry) => entry.capability), [null, "clinical-evidence-synthesis", "source-understanding"]);
    assert.deepEqual(header.sessions.map((entry) => entry.truncated), [false, false, false]);
    assert.equal(receipt.messages, 5);
    assert.deepEqual(records.map((entry) => entry.seq), [1, 2, 3, 4, 5]);
    assert.deepEqual(records.map((entry) => entry.sessionId), ["ses_root", "ses_root", "ses_child_a", "ses_child_a", "ses_child_b"]);
    assert.equal(records[2].parts[0].text, "search");
    // A finished run's container is being released as this reads; waking it
    // would restart the very thing whose exit ended the run.
    assert.deepEqual([...new Set(runtime.calls.map((call) => call.options.wake))], [false]);
  });
});

test("a subagent session that can no longer be read is recorded as a partial transcript, not a smaller complete one", async () => {
  await withProject(async (project) => {
    const runtime = delegatingRun();
    runtime.sessions.set("ses_child_b", unreadable());
    const run = { id: "run_child_gone", sessionId: "ses_root" };

    const sessions = await collectRunTranscripts(runtime, project, run);
    const receipt = await persistRunTranscript({ project, run, sessions, now: new Date(CAPTURED_AT) });
    const { header, records } = await readLines(project, run.id);

    assert.equal(receipt.completeness, "partial");
    assert.deepEqual(receipt.missing, [{ sessionId: "ses_child_b", fromSeq: 0, reason: "child_unreadable" }]);
    assert.equal(sessions[2].error, "runtime_session_not_found");
    assert.deepEqual(header.sessions.map((entry) => entry.sessionId), ["ses_root", "ses_child_a", "ses_child_b"]);
    assert.deepEqual(records.filter((entry) => entry.sessionId === "ses_root").map((entry) => entry.seq), [1, 2]);
    assert.deepEqual(records.filter((entry) => entry.sessionId === "ses_child_a").map((entry) => entry.seq), [3, 4]);
    assert.equal(records.filter((entry) => entry.sessionId === "ses_child_b").length, 0);
  });
});

test("a session whose paging stopped short of its own head sequence is recorded as partial with the sequence it stopped at", () => {
  const runtime = delegatingRun();
  const paged = transcript("ses_child_a", [message(3, "search"), message(4, "quote")], { lastSeq: 4210 });
  const sessions = [
    { sessionId: "ses_root", parentSessionId: null, label: "root", capability: null, error: null, transcript: runtime.sessions.get("ses_root") },
    { sessionId: "ses_child_a", parentSessionId: "ses_root", label: "subagent", capability: null, error: null, transcript: paged },
  ];

  const { header } = serializeRunTranscript({ runId: "run_paged", capturedAt: CAPTURED_AT, sessions });

  assert.equal(header.completeness, "partial");
  assert.deepEqual(header.missing, [{ sessionId: "ses_child_a", fromSeq: 5, reason: "page_bound" }]);
  assert.deepEqual(header.sessions[1], {
    sessionId: "ses_child_a",
    parentSessionId: "ses_root",
    label: "subagent",
    capability: null,
    lastSeq: 4210,
    throughSeq: 4,
    messages: 2,
    truncated: true,
  });
});

test("a run whose root session yields nothing is unavailable rather than an empty success", () => {
  const rootGone = serializeRunTranscript({
    runId: "run_root_gone",
    capturedAt: CAPTURED_AT,
    sessions: [{ sessionId: "ses_root", parentSessionId: null, label: "root", capability: null, transcript: null, error: "runtime_not_running" }],
  });
  const rootEmpty = serializeRunTranscript({
    runId: "run_root_empty",
    capturedAt: CAPTURED_AT,
    sessions: [{ sessionId: "ses_root", parentSessionId: null, label: "root", capability: null, transcript: transcript("ses_root", []), error: null }],
  });

  assert.equal(rootGone.header.completeness, "unavailable");
  assert.deepEqual(rootGone.header.missing, [{ sessionId: "ses_root", fromSeq: 0, reason: "history_unavailable" }]);
  assert.equal(rootGone.messages, 0);
  assert.equal(rootEmpty.header.completeness, "unavailable");
  assert.equal(rootEmpty.messages, 0);
});

test("a transcript too large for its cap is written as partial(size_bound) and the file that lands stays under the cap", async () => {
  await withProject(async (project) => {
    const long = Array.from({ length: 400 }, (_, index) => message(index + 1, `step ${index + 1} ${"reasoning ".repeat(20)}`));
    const sessions = [{
      sessionId: "ses_root",
      parentSessionId: null,
      label: "root",
      capability: null,
      error: null,
      transcript: transcript("ses_root", long),
    }];
    const run = { id: "run_big", sessionId: "ses_root" };
    const uncapped = serializeRunTranscript({ runId: run.id, capturedAt: CAPTURED_AT, sessions });
    const maxBytes = Math.floor(Buffer.byteLength(uncapped.text, "utf8") / 3);

    const receipt = await persistRunTranscript({ project, run, sessions, now: new Date(CAPTURED_AT), maxBytes });
    const { header, records, text } = await readLines(project, run.id);

    assert.equal(uncapped.header.completeness, "complete");
    assert.equal(receipt.completeness, "partial");
    assert.deepEqual(receipt.missing.filter((gap) => gap.reason === "size_bound").length, 1);
    assert.equal(receipt.missing.find((gap) => gap.reason === "size_bound").sessionId, "run_big");
    assert.equal(header.completeness, "partial");
    assert.ok(Buffer.byteLength(text, "utf8") <= maxBytes, `file is ${Buffer.byteLength(text, "utf8")} bytes, cap is ${maxBytes}`);
    assert.equal(receipt.bytes, Buffer.byteLength(text, "utf8"));
    assert.equal(receipt.messages, records.length);
    assert.ok(records.length < 400);
    // Whole messages, from the front: a half-written message is the state this
    // file exists to describe, not to be in.
    assert.deepEqual(records.map((entry) => entry.seq), records.map((_, index) => index + 1));
  });
});

test("the receipt's sha256 is the digest of the bytes on disk and the file reads back message for message", async () => {
  await withProject(async (project) => {
    const runtime = delegatingRun();
    const run = { id: "run_receipt", sessionId: "ses_root" };
    const sessions = await collectRunTranscripts(runtime, project, run);

    const receipt = await persistRunTranscript({ project, run, sessions, now: new Date(CAPTURED_AT) });
    const bytes = await readFile(transcriptPath(project, run.id));
    const stored = await readRunTranscript(project, run.id);

    assert.equal(receipt.path, path.join(".openscience", TRANSCRIPT_DIR_NAME, "run_receipt.jsonl"));
    assert.equal(path.isAbsolute(receipt.path), false);
    assert.equal(receipt.bytes, bytes.length);
    assert.equal(receipt.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(stored.header.completeness, "complete");
    assert.deepEqual(stored.header.sessions.map((entry) => entry.sessionId), ["ses_root", "ses_child_a", "ses_child_b"]);
    assert.equal(stored.messages.length, receipt.messages);
    assert.deepEqual(stored.messages.map((entry) => [entry.sessionId, entry.seq, entry.parts[0].text]), [
      ["ses_root", 1, "plan the review"],
      ["ses_root", 2, "delegate"],
      ["ses_child_a", 3, "search"],
      ["ses_child_a", 4, "quote"],
      ["ses_child_b", 5, "parse the source"],
    ]);
  });
});

test("a run with no stored transcript reads as null rather than as an error", async () => {
  await withProject(async (project) => {
    assert.equal(await readRunTranscript(project, "run_never_written"), null);
  });
});

test("a stored transcript whose header cannot be trusted is refused as run_transcript_corrupt", async () => {
  await withProject(async (project) => {
    const directory = path.join(project.metaDir, TRANSCRIPT_DIR_NAME);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(directory, "run_torn.jsonl"), "{not json\n", "utf8");
    await writeFile(
      path.join(directory, "run_old_schema.jsonl"),
      `${JSON.stringify({ schemaVersion: TRANSCRIPT_SCHEMA_VERSION - 1, runId: "run_old_schema", sessions: [], missing: [] })}\n`,
      "utf8",
    );

    await assert.rejects(readRunTranscript(project, "run_torn"), { code: "run_transcript_corrupt", status: 500 });
    await assert.rejects(readRunTranscript(project, "run_old_schema"), { code: "run_transcript_corrupt", status: 500 });
  });
});

test("the retention sweep removes only the transcripts older than the window", async () => {
  await withProject(async (project) => {
    const directory = path.join(project.metaDir, TRANSCRIPT_DIR_NAME);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const now = new Date("2026-09-07T00:00:00.000Z");
    const ageInDays = { run_fresh: 1, run_edge: 89, run_stale: 120 };
    for (const [runId, days] of Object.entries(ageInDays)) {
      const file = path.join(directory, `${runId}.jsonl`);
      await writeFile(file, "{}\n", "utf8");
      const when = new Date(now.getTime() - days * 86_400_000);
      await utimes(file, when, when);
    }
    await writeFile(path.join(directory, "notes.txt"), "not a transcript\n", "utf8");

    const { removed } = await pruneRunTranscripts(project, { now });

    assert.deepEqual(removed, ["run_stale.jsonl"]);
    assert.deepEqual((await readdir(directory)).sort(), ["notes.txt", "run_edge.jsonl", "run_fresh.jsonl"]);
  });
});

test("a project with no transcript directory sweeps to nothing instead of failing", async () => {
  await withProject(async (project) => {
    assert.deepEqual(await pruneRunTranscripts(project, { now: new Date() }), { removed: [] });
  });
});

test("an excerpt drops a message carrying a credential and counts the drop", () => {
  const messages = [
    { sessionId: "ses_root", seq: 1, parts: [{ type: "text", text: "read the trial registry" }] },
    { sessionId: "ses_root", seq: 2, parts: [{ type: "text", text: "the api key is sk-live-9f2c" }] },
    { sessionId: "ses_root", seq: 3, parts: [{ type: "text", text: "quote the primary endpoint" }] },
  ];

  const excerpt = transcriptExcerpt(messages);

  assert.deepEqual(excerpt.messages.map((entry) => entry.seq), [1, 3]);
  assert.deepEqual(excerpt.dropped, { sensitive: 1, bounded: 0 });
  assert.doesNotMatch(JSON.stringify(excerpt.messages), /sk-live-9f2c/);
});

test("an excerpt keeps the last messages within its limit and counts the rest as bounded", () => {
  const messages = Array.from({ length: 12 }, (_, index) => ({
    sessionId: "ses_root",
    seq: index + 1,
    parts: [{ type: "text", text: `step ${index + 1}` }],
  }));

  const excerpt = transcriptExcerpt(messages, { limit: 5 });

  assert.deepEqual(excerpt.messages.map((entry) => entry.seq), [8, 9, 10, 11, 12]);
  assert.deepEqual(excerpt.dropped, { sensitive: 0, bounded: 7 });
});

test("an excerpt restricted to one session and sequence window carries only that window", () => {
  const messages = [
    { sessionId: "ses_root", seq: 1, parts: [{ type: "text", text: "delegate" }] },
    { sessionId: "ses_child_a", seq: 2, parts: [{ type: "text", text: "before" }] },
    { sessionId: "ses_child_a", seq: 3, parts: [{ type: "text", text: "the repair" }] },
    { sessionId: "ses_child_a", seq: 4, parts: [{ type: "text", text: "the fix" }] },
    { sessionId: "ses_child_a", seq: 9, parts: [{ type: "text", text: "after" }] },
  ];

  const excerpt = transcriptExcerpt(messages, { sessionId: "ses_child_a", fromSeq: 3, toSeq: 4 });

  assert.deepEqual(excerpt.messages.map((entry) => entry.seq), [3, 4]);
  assert.deepEqual(excerpt.dropped, { sensitive: 0, bounded: 0 });
});

test("collection follows a grandchild session that a subagent announced", async () => {
  await withProject(async (project) => {
    const runtime = new FakeRuntime({
      ses_root: transcript("ses_root", [message(1, "plan")], { subagents: [subagent("ses_child_a", "clinical-evidence-synthesis")] }),
      ses_child_a: transcript("ses_child_a", [message(2, "delegate again")], {
        subagents: [{ sessionId: "ses_grandchild", parentSessionId: "ses_child_a", label: "subagent", capability: "source-understanding" }],
      }),
      ses_grandchild: transcript("ses_grandchild", [message(3, "the work happened here")]),
    });

    const sessions = await collectRunTranscripts(runtime, project, { id: "run_deep", sessionId: "ses_root" });
    const { header, messages } = serializeRunTranscript({ runId: "run_deep", capturedAt: CAPTURED_AT, sessions });

    assert.deepEqual(sessions.map((entry) => entry.sessionId), ["ses_root", "ses_child_a", "ses_grandchild"]);
    assert.equal(header.completeness, "complete");
    assert.equal(header.sessions[2].parentSessionId, "ses_child_a");
    assert.equal(messages, 3);
  });
});

test("collection stops at maxSessions instead of following an unbounded fan-out", async () => {
  await withProject(async (project) => {
    const fanout = Array.from({ length: 8 }, (_, index) => subagent(`ses_child_${index}`, "source-understanding"));
    const sessionsByName = { ses_root: transcript("ses_root", [message(1, "plan")], { subagents: fanout }) };
    for (const child of fanout) sessionsByName[child.sessionId] = transcript(child.sessionId, [message(2, "work")]);
    const runtime = new FakeRuntime(sessionsByName);

    const sessions = await collectRunTranscripts(runtime, project, { id: "run_fanout", sessionId: "ses_root" }, { maxSessions: 3 });

    assert.deepEqual(sessions.map((entry) => entry.sessionId), ["ses_root", "ses_child_0", "ses_child_1"]);
    assert.equal(runtime.calls.length, 3);
  });
});

test("a collection that stopped at the root would fail every claim the complete case makes", async () => {
  await withProject(async (project) => {
    const runtime = delegatingRun();
    const run = { id: "run_control", sessionId: "ses_root" };
    // The mutation, applied to a copy rather than to the source: the child
    // fan-out is gone and nothing else changes. The assertions below are the
    // ones the complete case makes, so this pins them to the walk itself — a
    // collector that silently stopped at the root would still produce a file,
    // a "complete" verdict and a sha256, and every other assertion in this
    // suite would still pass.
    const rootOnly = [{
      sessionId: run.sessionId,
      parentSessionId: null,
      label: "root",
      capability: null,
      error: null,
      transcript: await runtime.sessionTranscript(project, run.sessionId, { wake: false }),
    }];

    const stopped = serializeRunTranscript({ runId: run.id, capturedAt: CAPTURED_AT, sessions: rootOnly });
    const walked = serializeRunTranscript({
      runId: run.id,
      capturedAt: CAPTURED_AT,
      sessions: await collectRunTranscripts(runtime, project, run),
    });

    assert.equal(stopped.header.completeness, "complete");
    assert.equal(stopped.header.sessions.length, 1);
    assert.equal(stopped.messages, 2);
    assert.doesNotMatch(stopped.text, /ses_child_a/);
    assert.equal(walked.header.sessions.length, 3);
    assert.equal(walked.messages, 5);
    assert.match(walked.text, /"sessionId":"ses_child_a"/);
    assert.match(walked.text, /"text":"search"/);
  });
});
