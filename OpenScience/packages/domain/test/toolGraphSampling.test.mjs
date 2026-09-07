// The tool dependency graph and the walk over it.
//
// Everything here is checked for *determinism* first and correctness second,
// because the failure this module exists to prevent is a corpus that quietly
// regenerates differently and takes the baseline with it.
import assert from "node:assert/strict";
import test from "node:test";

import {
  TOOL_GRAPH_ISSUE_CODES,
  chainSpecs,
  graphCoverage,
  sampleableEdges,
  sanitizeToolGraph,
  seededRandom,
  seededSample,
  unlockSchedule,
  validateToolGraph,
} from "../src/toolGraphSampling.mjs";

/** @param {string} name @returns {{name: string}} */
const node = (name) => ({ name });
/**
 * @param {string} from @param {string} to
 * @param {Partial<import("../src/toolGraphSampling.mjs").ToolGraphEdge>} [extra]
 * @returns {import("../src/toolGraphSampling.mjs").ToolGraphEdge}
 */
const edge = (from, to, extra = {}) => ({ from, to, type: "parameter", via: "executed", validatedBy: "run_1", ...extra });

/** search -> fetch -> appraise -> write, plus an unrelated tool. */
const LINEAR = {
  capability: "clinical-evidence-synthesis",
  nodes: ["search", "fetch", "appraise", "write", "loner"].map(node),
  edges: [edge("search", "fetch"), edge("fetch", "appraise"), edge("appraise", "write")],
};

test("the same seed produces the same sample on any machine", () => {
  const items = ["a", "b", "c", "d", "e", "f"];
  assert.deepEqual(seededSample(items, 3, "s1"), seededSample(items, 3, "s1"));
  assert.notDeepEqual(seededSample(items, 3, "s1"), seededSample(items, 3, "s2"));
  // Input order must not matter, or a caller iterating a Set changes the corpus.
  assert.deepEqual(seededSample(items, 3, "s1"), seededSample([...items].reverse(), 3, "s1"));
  assert.deepEqual(seededSample(items, 99, "s1").length, items.length);
  assert.deepEqual(seededSample([], 3, "s1"), []);
  const random = seededRandom("x");
  const first = [random(), random(), random()];
  const again = seededRandom("x");
  assert.deepEqual(first, [again(), again(), again()]);
  for (const value of first) assert.ok(value >= 0 && value < 1);
});

test("unlock sampling produces one stage per unlocked layer, width bounded by n", () => {
  const { stages, unreached } = unlockSchedule(LINEAR, { n: 1, seed: "t" });
  assert.deepEqual(unreached, []);
  // Two roots (search, loner) with n=1 means the first two stages are each one
  // root; the chain then unlocks one tool at a time.
  assert.deepEqual(stages.flat().sort(), ["appraise", "fetch", "loner", "search", "write"]);
  for (const stage of stages) assert.ok(stage.length <= 1);
  const order = stages.flat();
  assert.ok(order.indexOf("search") < order.indexOf("fetch"));
  assert.ok(order.indexOf("fetch") < order.indexOf("appraise"));
  assert.ok(order.indexOf("appraise") < order.indexOf("write"));

  const wide = unlockSchedule(LINEAR, { n: 5, seed: "t" });
  assert.deepEqual(wide.stages[0].sort(), ["loner", "search"], "both roots are ready at once");
  assert.deepEqual(unlockSchedule(LINEAR, { n: 2, seed: "t" }).stages, unlockSchedule(LINEAR, { n: 2, seed: "t" }).stages);
});

test("only an executed edge can carry a task", () => {
  const mixed = {
    nodes: ["a", "b", "c"].map(node),
    edges: [edge("a", "b"), edge("b", "c", { via: "model", validatedBy: null, confidence: 0.9 })],
  };
  assert.equal(sampleableEdges(mixed).length, 1);
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
  assert.deepEqual(unlockSchedule(graph, { n: 3, seed: "t" }).unreached, []);

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

test("coverage says what a corpus does not reach", () => {
  const specs = chainSpecs(LINEAR, { n: 1, seed: "c", chains: 2, minStages: 3 });
  assert.ok(specs.length >= 1);
  for (const spec of specs) {
    assert.ok(spec.stages.length >= 3);
    assert.equal(spec.n, 1);
    assert.ok(spec.seed.includes("c"));
  }
  const coverage = graphCoverage(LINEAR, [["search", "fetch"]]);
  assert.deepEqual(coverage, { tools: 5, covered: 2, ratio: 0.4, uncovered: ["appraise", "loner", "write"] });

  // A graph too shallow for the requested chain length yields nothing, rather
  // than a one-turn task calling itself long-horizon.
  assert.deepEqual(chainSpecs({ nodes: [node("only")], edges: [] }, { minStages: 3 }), []);
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
