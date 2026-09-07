// The two scripts that build the tool dependency graph and walk it into brief
// drafts, exercised end to end over a fixture rather than the real capability
// tree — the real tree changes for reasons that have nothing to do with these
// rules, and a test that moves with it stops being a claim about anything.
//
// The invariant worth the most here is the third one. `via: "executed"` is the
// only edge source a task may be built on, and the whole corpus is honest only
// while that holds: a task built on an edge nobody ran is unsolvable, and an
// unsolvable task inside an evaluation set is indistinguishable from a
// capability regression.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const buildScript = path.join(repoRoot, "scripts/dev/build-tool-graph.mjs");
const generateScript = path.join(repoRoot, "scripts/dev/generate-briefs.mjs");

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

test("a side file cannot mint a sampleable edge by claiming one was executed", async () => {
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

test("no brief is built on an edge that was never executed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tdg-unexecuted-"));
  try {
    await writeFixtureCapability(root, FIXTURE_TOOLS);
    await writeSideFiles(root, []);
    assert.equal(run(buildScript, buildArgs(root)).status, 0);

    const graph = JSON.parse(await readFile(path.join(root, "graphs", "tdg.probe-capability.json"), "utf8"));
    assert.ok(graph.edges.length > 0, "the fixture must propose edges, or the refusal proves nothing");
    assert.equal(graph.edges.filter((edge) => edge.via === "executed").length, 0);

    const generated = run(generateScript, [
      `--graphs=${path.join(root, "graphs")}`,
      `--out=${path.join(root, "briefs")}`,
    ]);
    assert.equal(generated.status, 0, generated.stderr);

    const drafts = JSON.parse(await readFile(path.join(root, "briefs/probe-capability/briefs.draft.json"), "utf8"));
    assert.deepEqual(drafts.briefs, [], "a schema edge is a proposal and must carry no task");
    assert.equal(drafts.status, "empty");

    const report = JSON.parse(await readFile(path.join(root, "briefs/probe-capability/generation-report.json"), "utf8"));
    assert.equal(report.skippedEdges.total, graph.edges.length);
    assert.equal(report.skippedEdges.byVia.schema, graph.edges.length);
    assert.equal(report.coverage.covered, 0);

    const requests = await readdir(path.join(root, "briefs/probe-capability/requests"));
    assert.deepEqual(requests, [], "a request to write prose for a task that cannot exist is still a task");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an executed chain becomes a draft that names the runs its golden trace comes from", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tdg-executed-"));
  try {
    await writeFixtureCapability(root, FIXTURE_TOOLS);
    await writeSideFiles(root, EXECUTED_LINES);
    assert.equal(run(buildScript, buildArgs(root)).status, 0);

    const generated = run(generateScript, [
      `--graphs=${path.join(root, "graphs")}`,
      `--out=${path.join(root, "briefs")}`,
      "--min-stages=3",
    ]);
    assert.equal(generated.status, 0, generated.stderr);

    const drafts = JSON.parse(await readFile(path.join(root, "briefs/probe-capability/briefs.draft.json"), "utf8"));
    assert.ok(drafts.briefs.length > 0);
    assert.equal(drafts.status, "awaiting-prose");
    const [first] = drafts.briefs;
    assert.deepEqual(Object.keys(first), ["id", "title", "why", "inputs", "mustDo", "mustNotDo", "gradedOn", "generated"]);
    // Null, not "": a draft whose prose reads as written is a draft that gets
    // committed as corpus.
    assert.equal(first.title, null);
    assert.equal(first.gradedOn, null);
    assert.deepEqual(Object.keys(first.generated).sort(), ["chain", "seed", "stages", "tdgVersion"]);

    const graph = JSON.parse(await readFile(path.join(root, "graphs", "tdg.probe-capability.json"), "utf8"));
    assert.equal(first.generated.tdgVersion, graph.version);
    assert.deepEqual(first.generated.stages.flat().sort(), [
      "mcp__evimed__adr_case_query",
      "mcp__evimed__drug_label_search",
      "mcp__evimed__drug_term_normalize",
      "write",
    ]);

    const request = JSON.parse(
      await readFile(path.join(root, "briefs/probe-capability/requests", `${first.generated.chain}.request.json`), "utf8"),
    );
    assert.equal(request.goldenTrace, null, "the trace is the input this step is waiting for");
    assert.deepEqual(request.goldenTraceSources.map((entry) => entry.validatedBy).sort(), [
      "run_fixture_1",
      "run_fixture_2",
      "run_fixture_3",
    ]);
    assert.ok(request.chainEdges.every((edge) => edge.via === "executed"));
    assert.equal(request.requirements.length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the generation report names every tool the corpus does not reach", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tdg-coverage-"));
  try {
    await writeFixtureCapability(root, FIXTURE_TOOLS);
    await writeSideFiles(root, EXECUTED_LINES);
    assert.equal(run(buildScript, buildArgs(root)).status, 0);
    assert.equal(
      run(generateScript, [`--graphs=${path.join(root, "graphs")}`, `--out=${path.join(root, "briefs")}`]).status,
      0,
    );

    const graph = JSON.parse(await readFile(path.join(root, "graphs", "tdg.probe-capability.json"), "utf8"));
    const report = JSON.parse(await readFile(path.join(root, "briefs/probe-capability/generation-report.json"), "utf8"));

    // Named, not counted: a ratio tells a reader the corpus is incomplete, and
    // a list tells them which task they cannot yet ask anybody about.
    assert.ok(report.coverage.uncovered.includes(MCP("literature_search")));
    assert.ok(report.coverage.uncovered.includes(MCP("open_access_full_text")));
    assert.ok(report.coverage.uncovered.includes("bash"));
    assert.equal(report.coverage.tools, graph.nodes.length);
    assert.equal(report.coverage.covered + report.coverage.uncovered.length, graph.nodes.length);

    const covered = new Set(report.briefs.flatMap((entry) => entry.tools));
    for (const name of report.coverage.uncovered) assert.ok(!covered.has(name), `${name} is both covered and uncovered`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--dry-run reports the same corpus it would write and writes nothing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tdg-dry-"));
  try {
    await writeFixtureCapability(root, FIXTURE_TOOLS);
    await writeSideFiles(root, EXECUTED_LINES);
    assert.equal(run(buildScript, buildArgs(root)).status, 0);

    const dry = run(generateScript, [
      `--graphs=${path.join(root, "graphs")}`,
      `--out=${path.join(root, "briefs")}`,
      "--dry-run",
    ]);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /would write/);
    await assert.rejects(readdir(path.join(root, "briefs")), /ENOENT/);
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

test("a collected receipt becomes a sampleable edge, which is the whole point", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tdg-collect-"));
  try {
    const { mergeReceipts, serializeCorpus } = await import("../../../scripts/dev/collect-executed-edges.mjs");
    const { sampleableEdges } = await import("@evimed/domain");
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
    assert.equal(sampleableEdges(graph).length, 1, "which is the first sampleable edge the corpus has ever had");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/* ----------------------------------------------- from a real run to a hidden reference */

test("a run's own trace becomes the chain's golden trace, matched by the run that proved the edge", async () => {
  const { traceForChain } = await import("../../../scripts/dev/generate-briefs.mjs");
  const spec = { id: "c-1", tools: [MCP("literature_search"), MCP("open_access_full_text")], stages: [], seed: "s", n: 2 };
  const sources = [{ from: MCP("literature_search"), to: MCP("open_access_full_text"), validatedBy: "run_real_1" }];
  const step = (tool) => ({ turn: 0, tool, args: {}, returnDigest: `sha256:${"0".repeat(64)}`, outputKeys: [] });
  const traces = [
    // Right capability, right tools, wrong run: another task that happens to
    // use the same two tools would describe work no recorded run ever did.
    { capability: "probe-capability", runId: "run_other", steps: [step(MCP("literature_search")), step(MCP("open_access_full_text"))] },
    { capability: "probe-capability", runId: "run_real_1", steps: [step(MCP("literature_search")), step(MCP("open_access_full_text")), step("read")] },
    { capability: "probe-capability", runId: "run_real_1", steps: [step(MCP("literature_search"))] },
    { capability: "other-capability", runId: "run_real_1", steps: [step(MCP("literature_search")), step(MCP("open_access_full_text"))] },
  ];
  const picked = traceForChain({ spec, capability: "probe-capability", sources, traces });
  assert.equal(picked?.runId, "run_real_1");
  assert.equal(picked.steps.length, 3, "the shortest qualifying trace, so the brief describes the chain not the run");

  // A chain no run covers gets nothing rather than the nearest thing.
  const uncovered = traceForChain({
    spec: { ...spec, tools: [...spec.tools, MCP("adr_case_query")] },
    capability: "probe-capability", sources, traces,
  });
  assert.equal(uncovered, null);
});

test("the hidden reference carries the contract's artefacts and the trace's tools, and the grader carries neither", async () => {
  const { hiddenReference, graderDocument } = await import("../../../scripts/dev/generate-briefs.mjs");
  const contract = {
    contractKind: "adr-analysis-report",
    outputs: [{ path: "safety-report.md", required: true }, { path: "signals.csv", required: true }, { path: "agenda-delta.json", required: false }],
    checks: ["requiredOutputsExist", "citationsResolvable"],
  };
  const trace = {
    runId: "run_1",
    steps: [
      { turn: 0, tool: "b", args: { doi: "10.1001/x" }, returnDigest: `sha256:${"1".repeat(64)}`, outputKeys: ["hits"] },
      { turn: 1, tool: "a", args: {}, returnDigest: `sha256:${"2".repeat(64)}`, outputKeys: [] },
    ],
  };
  const reference = hiddenReference({ briefId: "adr-tdg-001", capability: "adr-analysis", trace, contract });
  assert.deepEqual(reference.expectedArtifacts, [
    { path: "safety-report.md", schema: "adr-analysis-report" },
    { path: "signals.csv", schema: "adr-analysis-report" },
  ], "an optional output is not something a run must produce");
  assert.deepEqual(reference.deterministicChecks, ["requiredOutputsExist", "citationsResolvable", "toolsExercised:a,b"]);
  assert.equal(reference.goldenTrace.runId, "run_1");

  // The grader is told what to check, never the answer.
  const grader = graderDocument({ capability: "adr-analysis", contract });
  const text = JSON.stringify(grader);
  assert.ok(!text.includes("goldenTrace") && !text.includes("10.1001/x") && !text.includes("sha256:"));
  assert.equal(grader.contractKind, "adr-analysis-report");
  assert.equal(grader.judgeRubricVersion, "1");

  // No trace yet is a reference that says so rather than one that invents one.
  assert.equal(hiddenReference({ briefId: "x", capability: "c", trace: null, contract }).goldenTrace, null);
});

test("a brief enters the corpus only if it replayed and a teacher solved it at least once", async () => {
  const { briefAcceptance } = await import("../../../scripts/dev/generate-briefs.mjs");
  const solved = { contractPassed: true, checksPassed: true };
  const failed = { contractPassed: false, checksPassed: false };
  assert.equal(briefAcceptance({ replayed: true, teacherRuns: [failed, solved, failed] }).accept, true);
  assert.match(briefAcceptance({ replayed: true, teacherRuns: [failed, solved, failed] }).reason, /1 of 3/);

  // A run that passed the contract but not the deterministic checks did not
  // solve it: the contract says the files are there, the checks say they are
  // the right files.
  assert.equal(briefAcceptance({ replayed: true, teacherRuns: [{ contractPassed: true, checksPassed: false }, failed, failed] }).accept, false);
  assert.equal(briefAcceptance({ replayed: false, teacherRuns: [solved, solved, solved] }).accept, false,
    "a task whose own reference solution does not replay is not solvable, whatever a teacher managed");
  assert.match(briefAcceptance({ replayed: true, teacherRuns: [solved] }).reason, /1 of 3 teacher attempts recorded/);
});

test("the hidden directory reaches no runtime tree, no distillation input and no prompt", async () => {
  // The leak this guards is silent in the only direction that matters: a
  // reference in context does not error, it produces a run that scores well for
  // the wrong reason, and every number after that is worthless with nothing
  // saying so.
  const generator = await readFile(path.join(repoRoot, "scripts", "dev", "generate-briefs.mjs"), "utf8");
  assert.match(generator, /"hidden"/, "the generator no longer writes a hidden reference");

  // Nothing that assembles context may name the directory.
  for (const file of [
    path.join(repoRoot, "apps", "server", "src", "methodDistillationRuns.mjs"),
    path.join(repoRoot, "apps", "server", "src", "learningRuntime.mjs"),
    path.join(repoRoot, "apps", "server", "src", "runtimeManager.mjs"),
  ]) {
    const source = await readFile(file, "utf8");
    assert.ok(!/hidden\/|\.reference\.json/.test(source), `${path.basename(file)} names the hidden corpus`);
  }
  // And the generated tree is not committed, so it cannot ride into an image.
  const ignore = await readFile(path.join(repoRoot, ".gitignore"), "utf8");
  assert.match(ignore, /evals\/tool-graph\/generated\//);
});

test("one real run walks the whole way: transcript to edge, trace, graph, draft and reference", async () => {
  // The seam test. Each half of this path had its own test and none crossed,
  // which is exactly how the corpus shipped with a producer nobody had wired.
  const { normalizeTranscript } = await import("../src/dshRuntimeAdapter.mjs");
  const { executedToolEdges, goldenTraces } = await import("../src/toolExecutionEdges.mjs");
  const { mergeReceipts, serializeCorpus } = await import("../../../scripts/dev/collect-executed-edges.mjs");
  const { main: generate } = await import("../../../scripts/dev/generate-briefs.mjs");

  const root = await mkdtemp(path.join(tmpdir(), "tdg-e2e-"));
  try {
    // 1. A run that searched, then fetched what the search returned.
    const transcript = normalizeTranscript("s1", [
      { event: { type: "turn/start", seq: 1, time: 1, data: { turn: 0 } } },
      { event: { type: "tool/call", seq: 2, time: 2, data: { turn: 0, name: MCP("literature_search"), callId: "c1", arguments: { query: "aspirin" } } } },
      { event: { type: "tool/result", seq: 3, time: 3, data: { turn: 0, callId: "c1", message: { callId: "c1", content: [{ type: "text", text: '{"hits":[{"doi":"10.1001/abc"}]}' }] } } } },
      { event: { type: "tool/call", seq: 4, time: 4, data: { turn: 1, name: MCP("open_access_full_text"), callId: "c2", arguments: { identifier: "10.1001/abc" } } } },
      { event: { type: "tool/result", seq: 5, time: 5, data: { turn: 1, callId: "c2", message: { callId: "c2", content: [{ type: "text", text: "full text" }] } } } },
    ]);
    const sessions = [{ sessionId: "s1", capability: "probe-capability", transcript }];

    // 2. What the terminal hook derives, verbatim.
    const edges = executedToolEdges({ runId: "run_real_1", sessions });
    const traces = goldenTraces({ runId: "run_real_1", sessions });
    assert.equal(edges.length, 1, "the run established one pair");
    assert.equal(traces[0].steps.length, 2);

    // 3. Collected into the corpus, and the graph rebuilt from it.
    await writeFixtureCapability(root, FIXTURE_TOOLS);
    await writeSideFiles(root, []);
    await writeFile(path.join(root, "executed-edges.jsonl"), serializeCorpus(mergeReceipts([JSON.stringify(edges[0])]).edges), "utf8");
    assert.equal(run(buildScript, buildArgs(root)).status, 0);

    // 4. The trace store the generator reads, as the hook writes it.
    await mkdir(path.join(root, "traces"), { recursive: true });
    await writeFile(path.join(root, "traces", "run_real_1.json"),
      JSON.stringify({ schemaVersion: "tool-trace/1", runId: "run_real_1", traces }), "utf8");
    await mkdir(path.join(root, "manifests"), { recursive: true });
    await writeFile(path.join(root, "manifests", "probe-capability.json"), JSON.stringify({
      produces: [{ contractKind: "probe-report", outputs: [{ path: "report.md", required: true }], checks: ["requiredOutputsExist"] }],
    }), "utf8");

    // 5. The generator, now able to ground a draft in a run that really happened.
    const code = await generate([
      `--graphs=${path.join(root, "graphs")}`,
      `--out=${path.join(root, "generated")}`,
      `--traces=${path.join(root, "traces")}`,
      `--manifests=${path.join(root, "manifests")}`,
      "--min-stages=1",
    ]);
    assert.equal(code, 0);

    const outDir = path.join(root, "generated", "probe-capability");
    const draft = JSON.parse(await readFile(path.join(outDir, "briefs.draft.json"), "utf8"));
    assert.ok(draft.briefs.length > 0, "an executed edge finally produced a draft");
    assert.equal(draft.briefs[0].title, null, "the prose still waits for the writing step, which needs a model");

    const requests = (await readdir(path.join(outDir, "requests"))).filter((entry) => entry.endsWith(".request.json"));
    const request = JSON.parse(await readFile(path.join(outDir, "requests", requests[0]), "utf8"));
    assert.equal(request.goldenTrace?.runId, "run_real_1", "the request is grounded in the run that proved the edge");
    assert.deepEqual(request.goldenTrace.steps.map((step) => step.tool), [MCP("literature_search"), MCP("open_access_full_text")]);

    const reference = JSON.parse(await readFile(path.join(outDir, "hidden", `${draft.briefs[0].id}.reference.json`), "utf8"));
    assert.deepEqual(reference.expectedArtifacts, [{ path: "report.md", schema: "probe-report" }]);
    assert.ok(reference.deterministicChecks.includes("requiredOutputsExist"));
    const grader = JSON.parse(await readFile(path.join(outDir, "hidden", "grader.json"), "utf8"));
    assert.equal(grader.contractKind, "probe-report");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
