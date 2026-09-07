// Reading "A fed B" off a finished run, and refusing to read it where it is not there.
//
// The corpus this feeds decides which tool chains the paired evaluation may
// build tasks on, so a false edge does not produce a wrong number — it produces
// a task nobody can solve, which then reads in a report as a capability
// regression. Every test here is about a case where the naive rule would invent
// one.
import assert from "node:assert/strict";
import test from "node:test";

import {
  carriedIdentifiers,
  completedToolCalls,
  executedToolEdges,
  serializeExecutedEdges,
} from "../src/toolExecutionEdges.mjs";

// The normalized `RunTranscript` vocabulary — the one `sessionTranscript`
// returns and `collectRunTranscripts` collects. Written out rather than nested
// under `state`, because the nested spelling is the ledger's and reading it
// here found nothing in a real run while every test stayed green. The last test
// in this file drives the real normalizer so the shape is proven, not restated.
/** @param {string} tool @param {any} input @param {any} output @param {any} [extra] */
const call = (tool, input, output, extra = {}) => ({
  type: "tool",
  tool,
  callId: `${tool}-${Math.random().toString(16).slice(2, 8)}`,
  status: "completed",
  input,
  output: typeof output === "string" ? output : JSON.stringify(output),
  error: null,
  ...extra,
});

/** @param {string} capability @param {any[]} parts */
const session = (capability, parts) => ({
  sessionId: `s:${capability}`,
  capability,
  transcript: { messages: parts.map((part, index) => ({ role: "tool", turn: index, parts: [part] })) },
});

test("identifiers are the ones the delivery gate already knows, plus artefact paths", () => {
  const found = carriedIdentifiers({
    hits: [{ doi: "10.1001/JAMA.2020.1234", pmid: "PMID: 3212" }],
    note: "see pubmed.ncbi.nlm.nih.gov/31234567 and PMC7654321 and NCT01234567",
    file: "evidence/screening.json",
  });
  assert.ok(found.has("doi:10.1001/jama.2020.1234"), "a DOI is case-folded so two spellings are one identifier");
  assert.ok(found.has("pmid:31234567"));
  assert.ok(found.has("pmcid:PMC7654321"));
  assert.ok(found.has("nct:NCT01234567"));
  assert.ok(found.has("path:evidence/screening.json"));

  assert.ok(![...found].some((entry) => entry === "pmid:3212"),
    "four digits is not a PMID; a looser rule would make every page number an identifier");

  // Prose that looks like a path is not a path.
  assert.deepEqual([...carriedIdentifiers("we filed it under evidence/screening and moved on")], []);
  assert.deepEqual([...carriedIdentifiers(null)], []);
  assert.deepEqual([...carriedIdentifiers(undefined)], []);
});

test("a value one tool produced and a later tool used is an edge", () => {
  const edges = executedToolEdges({
    runId: "run_1",
    sessions: [session("clinical-evidence-synthesis", [
      call("search", { query: "aspirin" }, { hits: [{ doi: "10.1001/abc" }] }),
      call("fetch", { doi: "10.1001/abc" }, { text: "..." }),
    ])],
  });
  assert.deepEqual(edges, [{
    capability: "clinical-evidence-synthesis",
    from: "search",
    to: "fetch",
    type: "parameter",
    validatedBy: "run_1",
    matchedIdentifiers: ["doi:10.1001/abc"],
  }]);
});

test("an identifier the brief supplied is never attributed to a tool", () => {
  // The commonest false edge: the researcher named the paper, the search tool
  // echoed it back, and a later fetch used it. Nothing about that says search
  // fed fetch, and once a value has come in from outside no later coincidence
  // makes it evidence.
  const edges = executedToolEdges({
    runId: "run_1",
    sessions: [session("clinical-evidence-synthesis", [
      call("fetch", { doi: "10.1001/abc" }, { text: "..." }),
      call("search", { query: "aspirin" }, { hits: [{ doi: "10.1001/abc" }] }),
      call("appraise", { doi: "10.1001/abc" }, { grade: "moderate" }),
    ])],
  });
  assert.deepEqual(edges, []);
});

test("a failed call neither produces nor consumes", () => {
  const failed = executedToolEdges({
    runId: "run_1",
    sessions: [session("c", [
      call("search", { q: "x" }, { doi: "10.1001/abc" }, { status: "error", error: { name: "UpstreamError", code: "upstream_timeout" } }),
      call("fetch", { doi: "10.1001/abc" }, { text: "..." }),
    ])],
  });
  assert.deepEqual(failed, [], "an edge means the pair ran and worked");

  const running = executedToolEdges({
    runId: "run_1",
    sessions: [session("c", [
      { type: "tool", tool: "search", callId: "c1", status: "pending", input: {}, output: JSON.stringify({ doi: "10.1001/abc" }), error: null },
      call("fetch", { doi: "10.1001/abc" }, { text: "..." }),
    ])],
  });
  assert.deepEqual(running, []);
});

test("a tool never feeds itself, and one pair is one edge however often it repeats", () => {
  const edges = executedToolEdges({
    runId: "run_1",
    sessions: [session("c", [
      call("search", { q: "a" }, { doi: "10.1001/one" }),
      call("search", { doi: "10.1001/one" }, { doi: "10.1001/two" }),
      call("fetch", { doi: "10.1001/two" }, { ok: true }),
      call("fetch", { doi: "10.1001/one" }, { ok: true }),
    ])],
  });
  assert.deepEqual(edges.map((edge) => [edge.from, edge.to]), [["search", "fetch"]]);
  assert.deepEqual(edges[0].matchedIdentifiers.sort(), ["doi:10.1001/one", "doi:10.1001/two"],
    "both values that flowed are named, so a reader can check the claim");
});

test("sessions are read apart, because a value crossing children crossed a gate", () => {
  const edges = executedToolEdges({
    runId: "run_1",
    sessions: [
      session("capability-a", [call("search", { q: "x" }, { doi: "10.1001/abc" })]),
      session("capability-b", [call("fetch", { doi: "10.1001/abc" }, { ok: true })]),
    ],
  });
  assert.deepEqual(edges, [], "that is the workflow's structure, not a tool dependency");
});

test("a session with no capability is skipped rather than filed under a guess", () => {
  const edges = executedToolEdges({
    runId: "run_1",
    sessions: [{ sessionId: "root", transcript: { messages: [
      { parts: [call("search", { q: "x" }, { doi: "10.1001/abc" })] },
      { parts: [call("fetch", { doi: "10.1001/abc" }, { ok: true })] },
    ] } }],
  });
  assert.deepEqual(edges, [], "the receipt's whole use is to name which graph the edge belongs in");
  assert.equal(executedToolEdges({ runId: "", sessions: [] }).length, 0);
});

test("calls are ordered by the kernel's sequence, not by where they sit in the list", () => {
  // "A then B" read off a list that is not in time order is not evidence.
  const parts = [
    call("fetch", { doi: "10.1001/abc" }, { ok: true }, { completedSeq: 20 }),
    call("search", { q: "x" }, { doi: "10.1001/abc" }, { completedSeq: 10 }),
  ];
  const ordered = completedToolCalls({ transcript: { messages: parts.map((part, index) => ({ turn: index, parts: [part] })) } });
  assert.deepEqual(ordered.map((entry) => entry.tool), ["search", "fetch"]);
  const edges = executedToolEdges({ runId: "run_1", sessions: [{ ...session("c", parts) }] });
  assert.deepEqual(edges.map((edge) => [edge.from, edge.to]), [["search", "fetch"]]);
});

test("a file one tool wrote and another read is an edge, which is the commonest real one", () => {
  const edges = executedToolEdges({
    runId: "run_1",
    sessions: [session("c", [
      call("evimed_screen", { q: "x" }, "wrote evidence/screening.jsonl with 141 rows"),
      call("read", { path: "evidence/screening.jsonl" }, "..."),
    ])],
  });
  assert.deepEqual(edges.map((edge) => [edge.from, edge.to, edge.matchedIdentifiers]),
    [["evimed_screen", "read", ["path:evidence/screening.jsonl"]]]);
});

test("the corpus form is one object per line, ordered so two runs compare", () => {
  const text = serializeExecutedEdges([
    { capability: "b", from: "x", to: "y", type: "parameter", validatedBy: "r", matchedIdentifiers: [] },
    { capability: "a", from: "x", to: "y", type: "parameter", validatedBy: "r", matchedIdentifiers: [] },
  ]);
  const lines = text.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => line.capability), ["a", "b"]);
  assert.equal(serializeExecutedEdges([]), "");
});

test("the shape is the one the real normalizer produces, not the one this file assumed", async () => {
  // The tooth for every fixture above. This module first read `part.state.status`
  // and `part.state.input` — the *ledger's* spelling, built by
  // `transcriptToLedgerMessages` for a different reader — while
  // `collectRunTranscripts` hands it the normalized `RunTranscript` that
  // `sessionTranscript` returns. Every test passed, because the fixtures were
  // written to the same wrong assumption, and in production not one receipt
  // would ever have been written.
  //
  // So this drives the real normalizer from kernel events. If the adapter's
  // output shape moves, this fails here rather than silently in a deployment.
  const { normalizeTranscript } = await import("../src/dshRuntimeAdapter.mjs");
  const events = [
    { event: { type: "turn/start", seq: 1, time: 1, data: { turn: 0 } } },
    { event: { type: "tool/call", seq: 2, time: 2, data: { turn: 0, name: "search", callId: "c1", arguments: { query: "aspirin" } } } },
    { event: { type: "tool/result", seq: 3, time: 3, data: { turn: 0, callId: "c1", message: { callId: "c1", name: "search", content: [{ type: "text", text: '{"hits":[{"doi":"10.1001/abc"}]}' }] } } } },
    { event: { type: "tool/call", seq: 4, time: 4, data: { turn: 1, name: "fetch", callId: "c2", arguments: { doi: "10.1001/abc" } } } },
    { event: { type: "tool/result", seq: 5, time: 5, data: { turn: 1, callId: "c2", message: { callId: "c2", name: "fetch", content: [{ type: "text", text: "full text" }] } } } },
  ];
  const transcript = normalizeTranscript("s1", events);
  const calls = completedToolCalls({ transcript });
  assert.deepEqual(calls.map((entry) => [entry.tool, entry.turn]), [["search", 0], ["fetch", 1]],
    "the normalizer's own output must be readable by this module");
  assert.deepEqual(calls[1].input, { doi: "10.1001/abc" });

  const edges = executedToolEdges({ runId: "run_real", sessions: [{ sessionId: "s1", capability: "adr-analysis", transcript }] });
  assert.deepEqual(edges.map((edge) => [edge.from, edge.to, edge.matchedIdentifiers]),
    [["search", "fetch", ["doi:10.1001/abc"]]]);
});

/* ------------------------------------------------------------- golden traces */

test("the golden trace is the run's own call sequence, with results reduced to digests", async () => {
  const { goldenTraces } = await import("../src/toolExecutionEdges.mjs");
  const traces = goldenTraces({
    runId: "run_1",
    sessions: [session("adr-analysis", [
      call("search", { query: "aspirin" }, { hits: [{ doi: "10.1001/abc" }], total: 1 }),
      call("fetch", { doi: "10.1001/abc" }, "plain text, not JSON"),
    ])],
  });
  assert.equal(traces.length, 1);
  assert.equal(traces[0].capability, "adr-analysis");
  assert.equal(traces[0].runId, "run_1");
  assert.deepEqual(traces[0].steps.map((step) => [step.tool, step.turn]), [["search", 0], ["fetch", 1]]);
  assert.deepEqual(traces[0].steps[0].args, { query: "aspirin" });
  // Digests, never the result text: a trace is committed to a corpus and tool
  // results carry retrieved source material.
  for (const step of traces[0].steps) {
    assert.match(step.returnDigest, /^sha256:[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(step).includes("10.1001/abc") || step.tool === "fetch");
  }
  assert.deepEqual(traces[0].steps[0].outputKeys, ["hits", "total"], "the shape a replay can be checked against");
  assert.deepEqual(traces[0].steps[1].outputKeys, [], "a non-JSON result has no keys, and claiming some would be a lie");
});

test("a trace names its capability or is not written, and the same run twice digests the same", async () => {
  const { goldenTraces } = await import("../src/toolExecutionEdges.mjs");
  assert.deepEqual(goldenTraces({ runId: "run_1", sessions: [{ sessionId: "root", transcript: { messages: [] } }] }), []);
  assert.deepEqual(goldenTraces({ runId: "", sessions: [] }), []);
  const once = goldenTraces({ runId: "r", sessions: [session("c", [call("a", { x: 1 }, { y: 2 })])] });
  const twice = goldenTraces({ runId: "r", sessions: [session("c", [call("a", { x: 1 }, { y: 2 })])] });
  assert.deepEqual(once, twice, "a corpus artefact that changes between two reads of one run is not evidence");
});
