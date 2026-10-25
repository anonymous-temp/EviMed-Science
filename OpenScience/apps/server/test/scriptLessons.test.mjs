// A script the person's own work keeps coming back to (2026-10-25): found by format in the tool calls of runs they left alone, identified by Python's own
// parser, and queued as one `script` lesson once the same program has been in three runs of two conversations.
//
// The normaliser is a Python program, and what matters about it is what Python does, so these tests run it for real (`python3 -I`, the same standard
// library the disposable container has) in place of the executor, and assert on the hashes. Everything around it — the extraction by format, the
// recurrence, the refusals — is the module's own.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  NORMALISE_PROGRAM, SCRIPT_CONVERSATIONS, SCRIPT_MIN_STATEMENTS, SCRIPT_RUNS, ScriptLessons, normaliseSnippets, pythonSnippetsOf, pythonSnippetsOfCall, scriptLessonFor, sensitiveSource,
} from "../src/scriptLessons.mjs";

const python = spawnSync("python3", ["-I", "-c", "print(1)"], { encoding: "utf8" });
const options = { skip: python.status !== 0 && "python3 is not available" };

/** The disposable executor, as a local interpreter: the program on the command line, the input on stdin, the answer in the result's `output`. */
const execute = async (/** @type {any} */ body) => {
  const result = spawnSync("python3", ["-I", "-c", body.code], { input: JSON.stringify(body.input ?? null), encoding: "utf8" });
  return { ok: result.status === 0, joined: true, executionStarted: true, output: result.stdout };
};

const CLEAN = `import pandas as pd
import numpy as np

def clean(frame, column):
    """Drop the empty rows and make the column numeric."""
    out = frame.dropna(subset=[column])
    out[column] = out[column].astype(float)
    return out

df = pd.read_csv("export_2026_10.csv")
df = clean(df, "hba1c")
print(df.describe())
df.to_csv("clean.csv", index=False)
`;
/** The same program with other names, other literals, another alias for the library and a different docstring. */
const CLEAN_AGAIN = `import pandas as pandas_lib
import numpy as np

def tidy(data, col):
    """Remove blanks; the column must be a number."""
    kept = data.dropna(subset=[col])
    kept[col] = kept[col].astype(float)
    return kept

table = pandas_lib.read_csv("another_file.csv")
table = tidy(table, "glucose")
print(table.describe())
table.to_csv("done.csv", index=False)
`;
/** A program that calls other things. */
const OTHER = `import pandas as pd

def clean(frame, column):
    out = frame.fillna(0)
    out[column] = out[column].round(2)
    return out

df = pd.read_csv("export.csv")
df = clean(df, "hba1c")
print(df.head())
df.to_json("clean.json")
`;

test("a program is taken out of a tool call by its format: a heredoc into python, python -c, a file written to a .py path, and a heredoc that writes one", () => {
  assert.deepEqual(pythonSnippetsOfCall("bash", { command: "cd data && python3 - <<'EOF'\nimport csv\nprint(1)\nEOF\nls" }), ["import csv\nprint(1)"]);
  assert.deepEqual(pythonSnippetsOfCall("bash", { command: "python3 <<EOF\nx = 1\nEOF" }), ["x = 1"]);
  assert.deepEqual(pythonSnippetsOfCall("bash", { command: "python3 -c 'import sys; print(sys.argv)' a b" }), ["import sys; print(sys.argv)"]);
  assert.deepEqual(pythonSnippetsOfCall("bash", { command: 'python -c "print(\\"hi\\")"' }), ['print("hi")']);
  assert.deepEqual(pythonSnippetsOfCall("bash", { command: "cat > analysis.py <<'PY'\nimport os\nprint(os.getcwd())\nPY\npython3 analysis.py" }), ["import os\nprint(os.getcwd())"]);
  assert.deepEqual(pythonSnippetsOfCall("write", { file_path: "scripts/report.py", content: "print('a')\n" }), ["print('a')\n"]);
  assert.deepEqual(pythonSnippetsOfCall("write", { path: "notes/readme.md", content: "print('a')" }), [], "not a .py path");
  assert.deepEqual(pythonSnippetsOfCall("bash", { command: "python3 analysis.py --input data.csv" }), [], "running a file is not carrying its program");
  assert.deepEqual(pythonSnippetsOfCall("bash", { command: "ls -la && echo done" }), []);
  assert.deepEqual(pythonSnippetsOfCall("read", { file_path: "x.py", content: "print(1)" }), [], "only the tools that run or write code");
  assert.deepEqual(pythonSnippetsOfCall("bash", {}), []);
});

test("a run's snippets are every program its calls carried, once each, in the order they were made, across its sessions", () => {
  const call = (/** @type {string} */ tool, /** @type {any} */ input, sessionId = "s") => ({ sessionId, role: "assistant", parts: [{ type: "tool", tool, status: "completed", input }] });
  const transcript = { messages: [
    call("bash", { command: "python3 - <<'EOF'\nprint(1)\nEOF" }),
    call("write", { file_path: "a.py", content: "print(2)" }, "child"),
    call("bash", { command: "python3 - <<'EOF'\nprint(1)\nEOF" }),
    { sessionId: "s", role: "assistant", parts: [{ type: "text", text: "python3 - <<'EOF'\nprint(3)\nEOF" }] },
  ] };
  assert.deepEqual(pythonSnippetsOf(transcript), ["print(1)", "print(2)"]);
  assert.deepEqual(pythonSnippetsOf(null), []);
});

test("Python's own parser says two scripts are one: other names, other literals, another alias and another docstring do not change the hash; other calls do", options, async () => {
  const rows = await normaliseSnippets(execute, [CLEAN, CLEAN_AGAIN, OTHER, "print(1)\n", "def (", "x = 1\n"]);
  const hashes = rows.map((row) => ("hash" in row ? row.hash : null));
  assert.equal(hashes[0], hashes[1], "the same script under other names");
  assert.notEqual(hashes[0], hashes[2], "a script that calls other things is another script");
  assert.match(String(hashes[0]), /^[a-f0-9]{32}$/);
  assert.deepEqual(rows[4], { id: "4", error: "unparsable" });
  assert.ok("statements" in rows[0] && rows[0].statements >= SCRIPT_MIN_STATEMENTS, "a real script has weight");
  assert.ok("statements" in rows[3] && rows[3].statements < SCRIPT_MIN_STATEMENTS, "a one-liner has none");
});

test("what is kept and what is not: attribute and keyword names are the API and stay, the order of binding is the identity, strings and numbers are placeholders", options, async () => {
  const hash = async (/** @type {string} */ source) => /** @type {any} */ ((await normaliseSnippets(execute, [source]))[0]).hash;
  assert.equal(await hash("a = f(x=1, y='p')\n"), await hash("b = f(x=7, y='q')\n"), "literals are placeholders");
  assert.notEqual(await hash("a = f(x=1)\n"), await hash("a = f(z=1)\n"), "a keyword is the API");
  assert.notEqual(await hash("a = obj.load()\n"), await hash("a = obj.save()\n"), "an attribute is the API");
  assert.notEqual(await hash("a = 1\nb = a\n"), await hash("a = 1\nb = c\n"), "a name used before it is bound is another program");
  assert.equal(await hash("a = 1\nb = a\n"), await hash("p = 2\nq = p\n"), "names are positions");
  assert.equal(await hash("import numpy as np\nnp.mean(x)\n"), await hash("import numpy\nnumpy.mean(y)\n"), "an alias is what it names");
  assert.equal(await hash("from math import sqrt as s\ns(2)\n"), await hash("from math import sqrt\nsqrt(9)\n"));
  assert.notEqual(await hash("a = True\n"), await hash("a = False\n"), "booleans are not placeholders");
  assert.equal(await hash("a: int = 3\n"), await hash("a = 4\n"), "an annotation is not a program");
  assert.equal(await hash("def f(a, b=1):\n    return a + b\n"), await hash("def g(c, d=2):\n    'doc'\n    return c + d\n"));
  assert.equal(await hash("a = f'{x} and {y}'\n"), await hash("a = f'{q} or {z}'\n"), "an f-string's text is a placeholder, its fields are not");
});

test("an executor that did not run the program, or answered nothing readable, is never guessed in place of: the batch throws", async () => {
  await assert.rejects(() => normaliseSnippets(async () => ({ ok: false, joined: true, output: "" }), ["x = 1"]), { code: "script_normaliser_unavailable" });
  await assert.rejects(() => normaliseSnippets(async () => ({ ok: true, joined: true, output: "not json" }), ["x = 1"]), { code: "script_normaliser_unreadable" });
  assert.deepEqual(await normaliseSnippets(async () => { throw new Error("must not be called"); }, []), []);
  // A row for an id nobody sent, or with a hash that is not one, is not read.
  const rows = await normaliseSnippets(async () => ({ ok: true, joined: true, output: JSON.stringify({ results: [{ id: "0", hash: "a".repeat(32), statements: 6, nodes: 30 }, { id: "9", hash: "b".repeat(32), statements: 6, nodes: 30 }, { id: "0", hash: "short" }] }) }), ["x = 1"]);
  assert.deepEqual(rows, [{ id: "0", hash: "a".repeat(32), statements: 6, nodes: 30 }]);
  assert.ok(NORMALISE_PROGRAM.length < 8000, "the program fits the executor's bound with room");
});

test("the lesson is one per script: three runs of two conversations, and nothing sooner", () => {
  const run = { id: "run_c" };
  const recurrence = (/** @type {number} */ runs, /** @type {number} */ conversations) => ({ runs, conversations, scope: "conversation", occurrences: [{ runId: "run_c", projectId: "p", sessionId: "s", at: "2026-10-25T00:00:00.000Z" }] });
  assert.equal(scriptLessonFor({ hash: "a".repeat(32), run, recurrence: recurrence(SCRIPT_RUNS - 1, 2) }), null);
  assert.equal(scriptLessonFor({ hash: "a".repeat(32), run, recurrence: recurrence(5, SCRIPT_CONVERSATIONS - 1) }), null, "three runs of one conversation are one conversation's habit");
  const lesson = scriptLessonFor({ hash: "a".repeat(32), run, recurrence: recurrence(SCRIPT_RUNS, SCRIPT_CONVERSATIONS) });
  assert.equal(lesson?.trigger, "script");
  assert.equal(lesson?.idempotencyKey, `distill:script:${"a".repeat(32)}`, "keyed on the script, so a fourth sighting queues nothing new");
  assert.deepEqual([lesson?.payload.scope, lesson?.payload.capabilityId, lesson?.payload.scriptHash, lesson?.payload.runs, lesson?.payload.conversations], ["conversation", null, "a".repeat(32), 3, 2]);
  assert.equal(scriptLessonFor({ hash: "a".repeat(32), run: null, recurrence: recurrence(9, 9) }), null);
  assert.equal(scriptLessonFor({ hash: "a".repeat(32), run, recurrence: { ...recurrence(3, 2), scope: "meta-analysis" } })?.payload.capabilityId, "meta-analysis");
});

/** An in-memory ledger of occurrences with the recurrence the SQL computes. */
function usesDouble() {
  /** @type {any[]} */ const rows = [];
  return {
    rows,
    async record(/** @type {string} */ _userId, /** @type {any} */ run) {
      let added = 0;
      for (const script of run.scripts) if (!rows.some((row) => row.hash === script.hash && row.runId === run.runId)) { rows.push({ ...run, hash: script.hash, source: script.source }); added += 1; }
      return added;
    },
    async recurrence(/** @type {string} */ _userId, /** @type {string} */ hash) {
      const mine = rows.filter((row) => row.hash === hash);
      return { runs: mine.length, conversations: new Set(mine.map((row) => `${row.projectId}\u0000${row.sessionId}`)).size, scope: mine[0]?.scope ?? null,
        occurrences: mine.map((row) => ({ runId: row.runId, projectId: row.projectId, sessionId: row.sessionId, at: row.at.toISOString() })) };
    },
  };
}

/** @param {string} source */
const transcriptOf = (source) => ({ header: {}, messages: [{ sessionId: "s", role: "assistant", parts: [{ type: "tool", tool: "bash", status: "completed", input: { command: `python3 - <<'EOF'\n${source}\nEOF` } }] }] });

test("the same program in three runs of two conversations queues one lesson; the third run of one conversation, a repeat of one run and a one-liner do not", options, async () => {
  const uses = usesDouble();
  /** @type {any[]} */ const queued = [];
  const counts = new Map();
  /** @type {Map<string, any>} */ const transcripts = new Map();
  const lessons = new ScriptLessons({
    uses: /** @type {any} */ (uses), execute, queue: () => async (_project, _run, lesson) => { queued.push(lesson); return true; },
    readTranscript: async (_project, runId) => transcripts.get(runId) ?? null,
    onOutcome: (outcome, times = 1) => counts.set(outcome, (counts.get(outcome) ?? 0) + times),
  });
  const settle = async (/** @type {string} */ runId, /** @type {string} */ sessionId, /** @type {string} */ source, project = "p") => {
    transcripts.set(runId, transcriptOf(source));
    return lessons.afterSettle({ userId: "u1", id: project }, { id: runId, sessionId, finishedAt: "2026-10-25T10:00:00.000Z" });
  };
  assert.deepEqual((await settle("run_1", "conv_a", CLEAN)).queued, []);
  assert.deepEqual((await settle("run_2", "conv_a", CLEAN_AGAIN)).queued, [], "two runs of one conversation");
  assert.deepEqual((await settle("run_2", "conv_a", CLEAN_AGAIN)).recorded, 0, "the same run again is recorded once");
  assert.deepEqual((await settle("run_3", "conv_a", CLEAN)).queued, [], "three runs of one conversation are one conversation's habit");
  const third = await settle("run_4", "conv_b", CLEAN_AGAIN);
  assert.equal(third.queued.length, 1);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].trigger, "script");
  assert.equal(queued[0].payload.runs, 4);
  assert.equal(queued[0].payload.conversations, 2);
  assert.deepEqual((await settle("run_5", "conv_b", CLEAN)).queued.length, 1, "queued again by the caller, which the queue's key makes one job");
  assert.equal(queued[1].idempotencyKey, queued[0].idempotencyKey);
  assert.equal((await settle("run_6", "conv_c", "print(1)")).recorded, 0, "a one-liner is not a script");
  assert.ok((counts.get("too_small") ?? 0) >= 1);
  assert.ok((counts.get("lesson_queued") ?? 0) >= 1 && (counts.get("recorded") ?? 0) >= 5);
});

test("a snippet that carries a credential is dropped before anything is stored, an executor that is not there records nothing, and a run with no transcript is nothing", options, async () => {
  const uses = usesDouble();
  const counts = new Map();
  /** @type {Map<string, any>} */ const transcripts = new Map();
  const secret = ["sk", "a".repeat(36)].join("-");
  const make = (/** @type {any} */ run) => new ScriptLessons({ uses: /** @type {any} */ (uses), execute: run, queue: () => async () => true,
    readTranscript: async (_project, runId) => transcripts.get(runId) ?? null, onOutcome: (outcome, times = 1) => counts.set(outcome, (counts.get(outcome) ?? 0) + times) });
  transcripts.set("run_s", transcriptOf(`${CLEAN}\nkey = "${secret}"`));
  assert.deepEqual(await make(execute).afterSettle({ userId: "u1", id: "p" }, { id: "run_s", sessionId: "c" }), { recorded: 0, queued: [] });
  assert.equal(counts.get("sensitive"), 1);
  assert.equal(uses.rows.length, 0);
  assert.equal(sensitiveSource(secret), true);
  assert.equal(sensitiveSource(CLEAN), false);

  transcripts.set("run_u", transcriptOf(CLEAN));
  assert.deepEqual(await make(async () => { throw Object.assign(new Error("busy"), { code: "runtime_capacity_full" }); }).afterSettle({ userId: "u1", id: "p" }, { id: "run_u", sessionId: "c" }), { recorded: 0, queued: [] });
  assert.equal(counts.get("executor_unavailable"), 1);
  assert.equal(uses.rows.length, 0, "no hash is guessed in Node");
  assert.deepEqual(await make(null).afterSettle({ userId: "u1", id: "p" }, { id: "run_u", sessionId: "c" }), { recorded: 0, queued: [] }, "no executor composed");
  assert.deepEqual(await make(execute).afterSettle({ userId: "u1", id: "p" }, { id: "run_gone", sessionId: "c" }), { recorded: 0, queued: [] });
  assert.equal(counts.get("no_transcript"), 1);
});
