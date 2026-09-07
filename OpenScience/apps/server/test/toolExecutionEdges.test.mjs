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

/** @param {string} tool @param {any} input @param {any} output @param {any} [extra] */
const call = (tool, input, output, extra = {}) => ({
  type: "tool",
  tool,
  state: { status: "completed", input, output, ...extra },
});

/** @param {string} capability @param {any[]} parts */
const session = (capability, parts) => ({
  sessionId: `s:${capability}`,
  capability,
  transcript: { messages: parts.map((part) => ({ parts: [part] })) },
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
      call("search", { q: "x" }, { doi: "10.1001/abc" }, { status: "completed", error: "upstream timeout" }),
      call("fetch", { doi: "10.1001/abc" }, { text: "..." }),
    ])],
  });
  assert.deepEqual(failed, [], "an edge means the pair ran and worked");

  const running = executedToolEdges({
    runId: "run_1",
    sessions: [session("c", [
      { type: "tool", tool: "search", state: { status: "running", input: {}, output: { doi: "10.1001/abc" } } },
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
    call("fetch", { doi: "10.1001/abc" }, { ok: true }, { status: "completed", completedSeq: 20 }),
    call("search", { q: "x" }, { doi: "10.1001/abc" }, { status: "completed", completedSeq: 10 }),
  ];
  const ordered = completedToolCalls({ transcript: { messages: parts.map((part) => ({ parts: [part] })) } });
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
