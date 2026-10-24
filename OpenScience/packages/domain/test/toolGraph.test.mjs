// The tool dependency graph.
//
// Everything here is checked for *determinism* first and correctness second,
// because the failure this module exists to prevent is a corpus that quietly
// regenerates differently and takes the baseline with it.
import assert from "node:assert/strict";
import test from "node:test";

import {
  TOOL_GRAPH_ISSUE_CODES,
  sanitizeToolGraph,
  validateToolGraph,
} from "../src/toolGraph.mjs";

/** @param {string} name @returns {{name: string}} */
const node = (name) => ({ name });
/**
 * @param {string} from @param {string} to
 * @param {Partial<import("../src/toolGraph.mjs").ToolGraphEdge>} [extra]
 * @returns {import("../src/toolGraph.mjs").ToolGraphEdge}
 */
const edge = (from, to, extra = {}) => ({ from, to, type: "parameter", via: "executed", validatedBy: "run_1", ...extra });

/** search -> fetch -> appraise -> write, plus an unrelated tool. */
const LINEAR = {
  capability: "clinical-evidence-synthesis",
  nodes: ["search", "fetch", "appraise", "write", "loner"].map(node),
  edges: [edge("search", "fetch"), edge("fetch", "appraise"), edge("appraise", "write")],
};

test("only an executed edge can carry a task", () => {
  const mixed = {
    nodes: ["a", "b", "c"].map(node),
    edges: [edge("a", "b"), edge("b", "c", { via: "model", validatedBy: null, confidence: 0.9 })],
  };
  assert.equal(mixed.edges.filter((entry) => entry.via === "executed").length, 1);
  const { graph, removed } = sanitizeToolGraph(mixed);
  assert.equal(graph.edges.length, 1);
  assert.match(removed[0].reason, /only an executed edge/);
  // A caller building a *proposal* graph can keep the unverified edges.
  assert.equal(sanitizeToolGraph(mixed, { requireExecuted: false }).graph.edges.length, 2);
});

test("a cycle is broken by the lowest-priority edge, and the removal is recorded", () => {
  const cyclic = {
    nodes: ["a", "b", "c"].map(node),
    edges: [
      edge("a", "b", { type: "parameter", confidence: 0.9 }),
      edge("b", "c", { type: "parameter", confidence: 0.9 }),
      edge("c", "a", { type: "semantic", confidence: 0.2 }),
    ],
  };
  const { graph, removed } = sanitizeToolGraph(cyclic);
  assert.equal(graph.edges.length, 2);
  assert.deepEqual([removed[0].edge.from, removed[0].edge.to], ["c", "a"], "the semantic edge goes first");
  assert.match(removed[0].reason, /cycle/);
  assert.deepEqual(sanitizeToolGraph(graph).removed, [], "what is left is a DAG: nothing more to break");

  // All-parameter cycle: confidence decides, and the result is stable.
  const equalTypes = {
    nodes: ["a", "b"].map(node),
    edges: [edge("a", "b", { confidence: 0.9 }), edge("b", "a", { confidence: 0.1 })],
  };
  const first = sanitizeToolGraph(equalTypes);
  assert.deepEqual([first.removed[0].edge.from, first.removed[0].edge.to], ["b", "a"]);
  const reversed = sanitizeToolGraph({ ...equalTypes, edges: [...equalTypes.edges].reverse() });
  assert.deepEqual([reversed.removed[0].edge.from, reversed.removed[0].edge.to], ["b", "a"], "array order must not decide");
});

test("parallel edges between the same pair collapse to the parameter one", () => {
  const parallel = {
    nodes: ["a", "b"].map(node),
    edges: [edge("a", "b", { type: "semantic" }), edge("a", "b", { type: "parameter" })],
  };
  const { graph, removed } = sanitizeToolGraph(parallel);
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0].type, "parameter");
  assert.match(removed[0].reason, /duplicate/);
});

test("an edge to a tool that is not a node, or a self loop, is dropped rather than trusted", () => {
  const broken = {
    nodes: ["a"].map(node),
    edges: [edge("a", "ghost"), edge("a", "a")],
  };
  const { graph, removed } = sanitizeToolGraph(broken);
  assert.deepEqual(graph.edges, []);
  assert.equal(removed.length, 2);
});

test("every declared graph issue code is raised by some case", () => {
  /** @type {Set<string>} */
  const raised = new Set();
  /** @param {any} graph */
  const check = (graph) => { for (const entry of validateToolGraph(graph).issues) raised.add(entry.code); };
  check({ nodes: [node("a"), node("a"), { name: "" }], edges: [] });
  check({
    nodes: [node("a"), node("b")],
    edges: [
      edge("a", "ghost"),
      edge("a", "a"),
      edge("a", "b", { type: "vibes" }),
      edge("a", "b", { via: "hunch" }),
      edge("a", "b", { stateEffect: "melts_the_disk" }),
      edge("a", "b", { via: "executed", validatedBy: null }),
      edge("a", "b", { confidence: 3 }),
    ],
  });
  const never = TOOL_GRAPH_ISSUE_CODES.filter((code) => !raised.has(code));
  assert.ok(raised.size >= 8, `only ${raised.size} codes exercised`);
  assert.deepEqual(never, [], `declared but never raised: ${never.join(", ")}`);
  assert.equal(validateToolGraph(LINEAR).ok, true);
});
