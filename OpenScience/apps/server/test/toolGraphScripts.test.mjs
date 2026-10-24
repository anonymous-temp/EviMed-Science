// The scripts that build the tool dependency graph and collect the receipts of runs into it, exercised end to end over a
// fixture rather than the real capability tree — the real tree changes for reasons that have nothing to do with these
// rules, and a test that moves with it stops being a claim about anything.
//
// The invariant worth the most here is that `via: "executed"` is the only edge source a task may be built on, and only
// a receipt with a run behind it may mint one: a task built on an edge nobody ran is unsolvable, and an unsolvable task
// inside an evaluation set is indistinguishable from a capability regression. (The walk that drafted briefs from the graph,
// `scripts/dev/generate-briefs.mjs`, was deleted on 2026-10-23: it had no executed edge to walk and produced no brief.)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const buildScript = path.join(repoRoot, "scripts/dev/build-tool-graph.mjs");

/** A slice of the real MCP declarations: enough tools to make every edge rule fire. */
const TOOL_DECLARATIONS = [
  {
    name: "drug_term_normalize",
    description: "Normalize a drug name against the public RxNorm vocabulary.",
    inputSchema: { type: "object", properties: { term: { type: "string" } }, required: ["term"] },
  },
  {
    name: "drug_label_search",
    description: "Search regulator-published drug labels.",
    inputSchema: {
      type: "object",
      properties: { drug: { type: "string" }, jurisdiction: { type: "string" } },
      required: ["drug"],
    },
  },
  {
    name: "adr_case_query",
    description: "Query adverse-event case reports.",
    inputSchema: {
      type: "object",
      properties: { drug: { type: "string" }, adverseEvent: { type: "string" } },
      required: ["drug"],
    },
  },
  {
    name: "literature_search",
    description: "Search the bibliographic indexes.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "open_access_full_text",
    description: "Resolve a PMCID, PMID, or DOI and write Markdown into the workspace.",
    inputSchema: { type: "object", properties: { identifier: { type: "string" } }, required: ["identifier"] },
  },
];

/**
 * A capability tree with one capability, so the assertions are about the rules
 * and not about whichever capability happens to mount which tool this month.
 * @param {string} root
 * @param {readonly string[]} tools
 */
async function writeFixtureCapability(root, tools) {
  const dir = path.join(root, "capabilities", "probe-capability");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "capability.yaml"),
    ["id: probe-capability", "tools:", ...tools.map((tool) => `- ${tool}`), ""].join("\n"),
    "utf8",
  );
}

/** @param {string} root @param {readonly string[]} lines */
async function writeSideFiles(root, lines) {
  await writeFile(path.join(root, "model-edges.json"), JSON.stringify({ edges: [] }), "utf8");
  await writeFile(path.join(root, "executed-edges.jsonl"), lines.length ? `${lines.join("\n")}\n` : "", "utf8");
  await writeFile(path.join(root, "tools.json"), JSON.stringify(TOOL_DECLARATIONS), "utf8");
}

/** @param {string} script @param {readonly string[]} args */
function run(script, args) {
  return spawnSync(process.execPath, [script, ...args], { cwd: repoRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

/** @param {string} root @param {readonly string[]} extra */
function buildArgs(root, extra = []) {
  return [
    `--capabilities=${path.join(root, "capabilities")}`,
    `--tools=${path.join(root, "tools.json")}`,
    `--model-edges=${path.join(root, "model-edges.json")}`,
    `--executed-edges=${path.join(root, "executed-edges.jsonl")}`,
    `--out=${path.join(root, "graphs")}`,
    ...extra,
  ];
}

const MCP = (base) => `mcp__evimed__${base}`;

const FIXTURE_TOOLS = [
  MCP("drug_term_normalize"),
  MCP("drug_label_search"),
  MCP("adr_case_query"),
  MCP("literature_search"),
  MCP("open_access_full_text"),
];

const EXECUTED_LINES = [
  JSON.stringify({
    capability: "probe-capability",
    from: MCP("drug_term_normalize"),
    to: MCP("drug_label_search"),
    type: "parameter",
    validatedBy: "run_fixture_1",
  }),
  JSON.stringify({
    capability: "probe-capability",
    from: MCP("drug_label_search"),
    to: MCP("adr_case_query"),
    type: "parameter",
    validatedBy: "run_fixture_2",
  }),
  JSON.stringify({
    capability: "probe-capability",
    from: MCP("adr_case_query"),
    to: "write",
    type: "parameter",
    validatedBy: "run_fixture_3",
  }),
];

test("--check passes on freshly built graphs and fails once one is hand edited", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tdg-check-"));
  try {
    await writeFixtureCapability(root, FIXTURE_TOOLS);
    await writeSideFiles(root, EXECUTED_LINES);

    const built = run(buildScript, buildArgs(root));
    assert.equal(built.status, 0, built.stderr);

    const fresh = run(buildScript, buildArgs(root, ["--check"]));
    assert.equal(fresh.status, 0, `a graph is not what the script would produce:\n${fresh.stderr}`);

    // The edit a reviewer would never notice: one edge deleted from a committed
    // graph. If --check only compared node counts this would pass, and the
    // corpus would quietly lose a task family.
    const graphPath = path.join(root, "graphs", "tdg.probe-capability.json");
    const graph = JSON.parse(await readFile(graphPath, "utf8"));
    const dropped = graph.edges.pop();
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    const drifted = run(buildScript, buildArgs(root, ["--check"]));
    assert.equal(drifted.status, 1, "a hand-edited graph must not pass --check");
    assert.match(drifted.stderr, /out of date/);
    assert.match(drifted.stderr, new RegExp(`\\+ edge ${dropped.from} -> ${dropped.to}`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an execution receipt with no run id behind it is refused rather than believed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tdg-receipt-"));
  try {
    await writeFixtureCapability(root, FIXTURE_TOOLS);
    await writeSideFiles(root, [
      JSON.stringify({ capability: "probe-capability", from: MCP("literature_search"), to: MCP("open_access_full_text"), type: "parameter" }),
    ]);

    const built = run(buildScript, buildArgs(root));
    assert.equal(built.status, 1, "a receipt naming no run must fail the build");
    assert.match(built.stderr, /records no run id/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a side file cannot mint an executed edge by claiming one was executed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tdg-mint-"));
  try {
    await writeFixtureCapability(root, FIXTURE_TOOLS);
    await writeSideFiles(root, []);
    await writeFile(
      path.join(root, "model-edges.json"),
      JSON.stringify({ edges: [{ from: MCP("literature_search"), to: MCP("adr_case_query"), type: "semantic", via: "executed", confidence: 1 }] }),
      "utf8",
    );

    const built = run(buildScript, buildArgs(root));
    assert.equal(built.status, 1, "a proposal file claiming an execution must fail the build");
    assert.match(built.stderr, /may only carry model edges/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the committed graphs are what the builder would produce today", () => {
  const checked = run(buildScript, ["--check"]);
  assert.equal(checked.status, 0, `evals/tool-graph has drifted:\n${checked.stderr}`);
});

/* --------------------------------------------------- collecting real receipts */

// The corpus had no producer. `executed-edges.jsonl` was committed empty, every
// edge in all fifteen graphs was `via: "schema"`, and only an executed edge may
// carry a task — so the brief generator honestly produced nothing and would
// have gone on producing nothing forever. The control plane now writes one
// receipt file per finished run into the project's own meta directory, and this
// script is the deliberate, human-run step that merges them into the corpus.
test("the collector merges run receipts, keeps the first run that proved a pair, and refuses the unprovable", async () => {
  const { mergeReceipts, serializeCorpus } = await import("../../../scripts/dev/collect-executed-edges.mjs");
  const line = (edge) => JSON.stringify(edge);
  const { edges, skipped } = mergeReceipts([
    [
      line({ capability: "adr-analysis", from: "a", to: "b", type: "parameter", validatedBy: "run_1", matchedIdentifiers: ["doi:10.1001/x"] }),
      line({ capability: "adr-analysis", from: "a", to: "b", type: "parameter", validatedBy: "run_9" }),
    ].join("\n"),
    [
      line({ capability: "adr-analysis", from: "b", to: "c", type: "parameter", validatedBy: "run_2" }),
      // No run id: nothing proves this pair ever ran, and `executed` is the one
      // source a task may be built on.
      line({ capability: "adr-analysis", from: "c", to: "d", type: "parameter" }),
      "{ not json",
      "",
    ].join("\n"),
  ]);
  assert.deepEqual(edges.map((edge) => [edge.from, edge.to, edge.validatedBy]), [
    ["a", "b", "run_1"],
    ["b", "c", "run_2"],
  ], "the first run to prove a pair keeps its name, so a reader can still go and check it");
  assert.equal(skipped.length, 2);
  assert.deepEqual(edges[0].matchedIdentifiers, ["doi:10.1001/x"]);

  // One capability at a time, when asked.
  const filtered = mergeReceipts([line({ capability: "other", from: "a", to: "b", type: "parameter", validatedBy: "r" })], { capability: "adr-analysis" });
  assert.deepEqual(filtered.edges, []);

  assert.equal(serializeCorpus([]), "");
  assert.match(serializeCorpus(edges), /\n$/);
});

test("a collected receipt becomes an executed edge, which is the whole point", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tdg-collect-"));
  try {
    const { mergeReceipts, serializeCorpus } = await import("../../../scripts/dev/collect-executed-edges.mjs");
    await writeFixtureCapability(root, FIXTURE_TOOLS);
    // Exactly what `persistExecutedToolEdges` writes for a run that searched and
    // then fetched.
    const { edges } = mergeReceipts([JSON.stringify({
      capability: "probe-capability",
      from: MCP("literature_search"),
      to: MCP("open_access_full_text"),
      type: "parameter",
      validatedBy: "run_real_1",
      matchedIdentifiers: ["doi:10.1001/x"],
    })]);
    await writeSideFiles(root, []);
    await writeFile(path.join(root, "executed-edges.jsonl"), serializeCorpus(edges), "utf8");

    const built = run(buildScript, buildArgs(root));
    assert.equal(built.status, 0, built.stderr);
    const graph = JSON.parse(await readFile(path.join(root, "graphs", "tdg.probe-capability.json"), "utf8"));
    const executed = graph.edges.filter((edge) => edge.via === "executed");
    assert.equal(executed.length, 1, "the receipt reached the graph");
    assert.equal(executed[0].validatedBy, "run_real_1", "and carries the run that proved it");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
