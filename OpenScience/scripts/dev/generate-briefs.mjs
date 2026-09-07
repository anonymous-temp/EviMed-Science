#!/usr/bin/env node
/**
 * Walks a tool dependency graph and emits brief drafts plus the request files
 * that finish them.
 *
 * ## Why the order is execute first, write the task second
 *
 * The tempting order is to invent a task and then check whether the agent can
 * do it. That produces tasks whose solvability is a hypothesis, and an
 * unsolvable task inside an evaluation set is indistinguishable from a
 * capability regression: the run fails, the score drops, and the corpus — not
 * the system — is what changed. Every incident of that kind costs a week
 * before anybody suspects the questions.
 *
 * So the corpus is built the other way round. A chain of tools is executed
 * first, in a recorded environment, with each turn's arguments copied from the
 * previous turn's output; the resulting call sequence is the golden trace. Only
 * then is the prose written, *from* that trace, describing a thing that has
 * already happened. A task written this way cannot be unsolvable, because a
 * solution is what it was made out of.
 *
 * ## Which half this script cannot do
 *
 * It cannot execute. Execution needs a fixture environment, the recorded
 * response gateway and a live kernel; this script reaches neither the network
 * nor a model, because a generator that did would produce a different corpus on
 * every run. What it can do is the three things that make the execution step
 * cheap and the writing step honest:
 *
 *  1. **Refuse to build a task on an edge nobody ran.** Only `via: "executed"`
 *     edges are walked; a `schema` or `model` edge is a proposal about what
 *     could work, and building a task on a proposal is exactly how an
 *     unsolvable question enters a corpus. The count of refusals is printed and
 *     written into the report rather than passed over in silence.
 *  2. **Name the runs that established each edge.** An executed edge carries
 *     the run id that executed it, so the request file tells the writing step
 *     which transcripts the golden trace has to be reconstructed from.
 *  3. **Hand the writing step a fully formed request** — the chain, its stages,
 *     every tool definition it touches, the in-edges, and the three properties
 *     the plan requires of the prose — and then stop. The prose fields of the
 *     draft stay `null`, because an empty string is a draft that looks
 *     finished and `null` is one that cannot be mistaken for one.
 *
 * A generation report is written next to the drafts, and it names the tools the
 * corpus does *not* cover. That is not a courtesy: a corpus that reports only
 * what it exercises reads as complete, and the first thing a reader needs from
 * an evaluation set is the shape of its blind spot.
 *
 * Usage:
 *   node scripts/dev/generate-briefs.mjs --capability=adr-analysis
 *   node scripts/dev/generate-briefs.mjs --out=/tmp/briefs --dry-run
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chainSpecs, graphCoverage, sampleableEdges, unlockSchedule } from "@evimed/domain";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The brief corpus schema of the committed `briefs.json` files, which the drafts must match. */
export const BRIEFS_SCHEMA_VERSION = "1.0.0";

/** The fields only the writing step can fill, listed once so the report can name them. */
export const PENDING_FIELDS = Object.freeze(["title", "why", "inputs", "mustDo", "mustNotDo", "gradedOn"]);

/**
 * What the plan requires of a brief written from a golden trace. Carried into
 * every request file verbatim, because the requirement is on the prose and the
 * prose is written elsewhere — this is the only place the contract can travel.
 */
export const BRIEF_REQUIREMENTS = Object.freeze([
  "Implicit dependency: state the high-level goal the researcher actually has. Do not list the tools, the steps or their order — the ordering is what the task is testing, so writing it down deletes the task.",
  "Information gap: where an early turn needs a value the brief does not supply, the brief must be answerable by stating an assumption and proceeding. The hosted surface does not ask the user back mid-run, so the assumption belongs in the deliverable's clarifications, not in a question.",
  "Consistency: the intent the brief states must be satisfied by what the last tool in the chain produces. A brief whose stated goal outruns its final artifact grades every correct run as incomplete.",
]);

/** Repo-relative where that is readable, absolute where it is not. @param {string} target @returns {string} */
function displayPath(target) {
  const relative = path.relative(repoRoot, target);
  return relative && !relative.startsWith("..") ? relative : target;
}

/**
 * `--flag=value`, `--flag value` and bare `--flag`, with repeats kept.
 * @param {readonly string[]} argv
 * @returns {Map<string, string[]>}
 */
export function parseArgs(argv) {
  /** @type {Map<string, string[]>} */
  const args = new Map();
  const push = (name, value) => args.set(name, [...(args.get(name) ?? []), value]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const equals = token.indexOf("=");
    if (equals > 0) {
      push(token.slice(2, equals), token.slice(equals + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      push(token.slice(2), next);
      index += 1;
    } else {
      push(token.slice(2), "");
    }
  }
  return args;
}

/**
 * The sub-graph a task may be walked on: the executed edges, and only the tools
 * they touch.
 *
 * A tool with no execution receipt is not dropped from the corpus — it stays in
 * the coverage numbers as something this corpus does not reach. Dropping it
 * would make the coverage ratio rise every time an edge went unverified, which
 * is the metric moving in the wrong direction on purpose.
 * @param {any} graph
 * @returns {{walk: any, skipped: {total: number, byVia: Record<string, number>}}}
 */
export function walkableGraph(graph) {
  const edges = sampleableEdges(graph);
  const touched = new Set(edges.flatMap((edge) => [edge.from, edge.to]));
  /** @type {Record<string, number>} */
  const byVia = {};
  for (const edge of graph?.edges ?? []) {
    if (edge.via === "executed") continue;
    byVia[edge.via] = (byVia[edge.via] ?? 0) + 1;
  }
  const skippedTotal = Object.values(byVia).reduce((sum, count) => sum + count, 0);
  return {
    walk: {
      capability: graph?.capability,
      version: graph?.version,
      nodes: (graph?.nodes ?? []).filter((node) => touched.has(node.name)),
      edges,
    },
    skipped: { total: skippedTotal, byVia },
  };
}

/**
 * One brief draft, in the corpus schema, with the prose left for the writing step.
 * @param {object} options
 * @param {string} options.capability
 * @param {string} options.tdgVersion
 * @param {number} options.index
 * @param {import('@evimed/domain').ChainSpec} options.spec
 * @returns {any}
 */
export function briefDraft(options) {
  const { capability, tdgVersion, index, spec } = options;
  return {
    id: `${capability}-tdg-${String(index + 1).padStart(3, "0")}`,
    title: null,
    why: null,
    inputs: null,
    mustDo: [],
    mustNotDo: [],
    gradedOn: null,
    generated: {
      tdgVersion,
      chain: spec.id,
      stages: spec.stages,
      seed: spec.seed,
    },
  };
}

/**
 * The request the writing step consumes: everything about the chain that is
 * decidable here, plus the run ids whose transcripts hold the golden trace.
 * @param {object} options
 * @param {any} options.graph
 * @param {string} options.briefId
 * @param {import('@evimed/domain').ChainSpec} options.spec
 * @returns {any}
 */
export function synthesisRequest(options) {
  const { graph, briefId, spec } = options;
  const inChain = new Set(spec.tools);
  const nodes = (graph.nodes ?? []).filter((node) => inChain.has(node.name));
  const edges = (graph.edges ?? []).filter((edge) => edge.via === "executed" && inChain.has(edge.from) && inChain.has(edge.to));
  const inbound = (graph.edges ?? []).filter((edge) => inChain.has(edge.to) && !inChain.has(edge.from));
  return {
    schemaVersion: BRIEFS_SCHEMA_VERSION,
    kind: "brief-synthesis-request",
    capability: graph.capability,
    tdgVersion: graph.version,
    briefId,
    chain: spec.id,
    seed: spec.seed,
    n: spec.n,
    stages: spec.stages,
    tools: nodes,
    chainEdges: edges,
    inboundEdges: inbound,
    // Null, not absent: the trace is the input this step is waiting for, and a
    // request that simply omitted it would read as a request that does not need
    // one.
    goldenTrace: null,
    goldenTraceSources: edges
      .map((edge) => ({ from: edge.from, to: edge.to, validatedBy: edge.validatedBy }))
      .sort((left, right) => `${left.from}->${left.to}`.localeCompare(`${right.from}->${right.to}`)),
    requirements: [...BRIEF_REQUIREMENTS],
    pendingFields: [...PENDING_FIELDS],
    stopReason: "The chain has to be replayed in the recorded environment before the prose is written; this generator reaches neither a model nor the network.",
  };
}

/**
 * Everything a corpus diff needs to explain itself, including what is not covered.
 * @param {object} options
 * @param {any} options.graph
 * @param {{total: number, byVia: Record<string, number>}} options.skipped
 * @param {any} options.walk
 * @param {readonly import('@evimed/domain').ChainSpec[]} options.specs
 * @param {{seed: string, chains: number, n: number, minStages: number, maxStages: number}} options.parameters
 * @returns {any}
 */
export function generationReport(options) {
  const { graph, skipped, walk, specs, parameters } = options;
  const coverage = graphCoverage(graph, specs.map((spec) => spec.tools));
  const { unreached } = unlockSchedule(walk, { n: parameters.n, seed: parameters.seed });
  return {
    schemaVersion: BRIEFS_SCHEMA_VERSION,
    kind: "brief-generation-report",
    capability: graph.capability,
    tdgVersion: graph.version,
    generatedBy: "scripts/dev/generate-briefs.mjs",
    parameters,
    walk: { nodes: walk.nodes.length, edges: walk.edges.length, unreached },
    skippedEdges: {
      total: skipped.total,
      byVia: skipped.byVia,
      reason: "Only an edge with an execution receipt may carry a task; a schema or model edge is a proposal, and a task built on a proposal fails in a way that reads as a capability regression.",
    },
    coverage: {
      tools: coverage.tools,
      covered: coverage.covered,
      ratio: Number(coverage.ratio.toFixed(4)),
      uncovered: coverage.uncovered,
    },
    briefs: specs.map((spec, index) => ({
      id: `${graph.capability}-tdg-${String(index + 1).padStart(3, "0")}`,
      chain: spec.id,
      stages: spec.stages.length,
      tools: spec.tools,
    })),
    pendingFields: [...PENDING_FIELDS],
  };
}

const HELP = `generate-briefs — brief drafts and their synthesis requests, from a tool graph

  node scripts/dev/generate-briefs.mjs [options]

  --capability=<id>   generate for this capability; repeatable, default every graph
  --graphs=<dir>      where tdg.<capability>.json lives (default: evals/tool-graph)
  --graph=<file>      one graph file, instead of --graphs/--capability
  --out=<dir>         output root (default: evals/tool-graph/generated)
  --seed=<string>     sampling seed (default: evimed)
  --chains=<n>        independent walks per graph (default: 5)
  --n=<n>             tools per turn, ToolVerse's only knob (default: 2)
  --min-stages=<n>    drop a chain shorter than this (default: 3)
  --max-stages=<n>    truncate a chain longer than this (default: 7)
  --dry-run           print what would be written, write nothing
  --help              this text

An edge that was not established by execution never carries a task; the count of
refusals and the tools the corpus does not cover are written into the report.
`;

/**
 * @param {readonly string[]} argv
 * @returns {Promise<number>}
 */
export async function main(argv) {
  const args = parseArgs(argv);
  if (args.has("help")) {
    process.stdout.write(HELP);
    return 0;
  }
  const dryRun = args.has("dry-run");
  const graphsDir = path.resolve(repoRoot, args.get("graphs")?.[0] || "evals/tool-graph");
  const outRoot = path.resolve(repoRoot, args.get("out")?.[0] || "evals/tool-graph/generated");
  const only = (args.get("capability") ?? []).filter(Boolean);
  const parameters = {
    seed: args.get("seed")?.[0] || "evimed",
    chains: Number(args.get("chains")?.[0] ?? 5),
    n: Number(args.get("n")?.[0] ?? 2),
    minStages: Number(args.get("min-stages")?.[0] ?? 3),
    maxStages: Number(args.get("max-stages")?.[0] ?? 7),
  };
  for (const [name, value] of Object.entries(parameters)) {
    if (name === "seed") continue;
    if (!Number.isInteger(value) || value < 1) {
      process.stderr.write(`--${name} must be a positive integer, got ${JSON.stringify(value)}\n`);
      return 1;
    }
  }

  /** @type {string[]} */
  let files = [];
  const single = args.get("graph")?.[0];
  if (single) {
    files = [path.resolve(repoRoot, single)];
  } else {
    const present = (await fs.readdir(graphsDir).catch(() => [])).filter((file) => /^tdg\..+\.json$/.test(file)).sort();
    if (!present.length) {
      process.stderr.write(`no tdg.<capability>.json under ${displayPath(graphsDir)}; run scripts/dev/build-tool-graph.mjs first\n`);
      return 1;
    }
    const selected = only.length ? present.filter((file) => only.includes(file.slice(4, -5))) : present;
    const missing = only.filter((name) => !present.includes(`tdg.${name}.json`));
    if (missing.length) {
      process.stderr.write(`no graph for: ${missing.join(", ")}\n`);
      return 1;
    }
    files = selected.map((file) => path.join(graphsDir, file));
  }

  let totalBriefs = 0;
  let totalSkipped = 0;
  for (const file of files) {
    let graph;
    try {
      graph = JSON.parse(await fs.readFile(file, "utf8"));
    } catch (error) {
      process.stderr.write(`${displayPath(file)}: unreadable — ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
    const capability = String(graph.capability ?? path.basename(file));
    const { walk, skipped } = walkableGraph(graph);
    const specs = chainSpecs(walk, parameters);
    const report = generationReport({ graph, skipped, walk, specs, parameters });
    const drafts = specs.map((spec, index) => briefDraft({ capability, tdgVersion: graph.version, index, spec }));
    const document = {
      schemaVersion: BRIEFS_SCHEMA_VERSION,
      capability,
      note: "Generated drafts. The prose fields are null until the writing step runs from the golden trace; see the request file beside each one. Nothing here is corpus until a human has reviewed it.",
      status: drafts.length ? "awaiting-prose" : "empty",
      briefs: drafts,
    };
    const outDir = path.join(outRoot, capability);

    totalBriefs += drafts.length;
    totalSkipped += skipped.total;
    process.stdout.write(
      `${capability}: ${drafts.length} draft(s) from ${walk.edges.length} executed edge(s); `
      + `${skipped.total} edge(s) skipped for want of an execution receipt; `
      + `coverage ${report.coverage.covered}/${report.coverage.tools}\n`,
    );
    if (report.coverage.uncovered.length) {
      process.stdout.write(`  not covered: ${report.coverage.uncovered.join(", ")}\n`);
    }
    if (dryRun) {
      process.stdout.write(`  would write ${displayPath(path.join(outDir, "briefs.draft.json"))}, generation-report.json and ${drafts.length} request file(s)\n`);
      continue;
    }

    await fs.mkdir(path.join(outDir, "requests"), { recursive: true });
    await fs.writeFile(path.join(outDir, "briefs.draft.json"), `${JSON.stringify(document, null, 2)}\n`, "utf8");
    await fs.writeFile(path.join(outDir, "generation-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    const stale = (await fs.readdir(path.join(outDir, "requests")).catch(() => [])).filter((entry) => entry.endsWith(".request.json"));
    for (const entry of stale) await fs.rm(path.join(outDir, "requests", entry));
    for (const [index, spec] of specs.entries()) {
      const request = synthesisRequest({ graph, briefId: drafts[index].id, spec });
      await fs.writeFile(path.join(outDir, "requests", `${spec.id}.request.json`), `${JSON.stringify(request, null, 2)}\n`, "utf8");
    }
    process.stdout.write(`  written to ${displayPath(outDir)}\n`);
  }

  process.stdout.write(
    `${totalBriefs} draft(s) across ${files.length} graph(s); ${totalSkipped} edge(s) refused for want of an execution receipt\n`,
  );
  if (!totalBriefs) {
    // Not an error. "Nothing has been executed yet" is a true state of the
    // corpus, and failing here would make the honest state look like a broken
    // pipeline — which is how a corpus ends up with fabricated edges.
    process.stdout.write("no chain was executed yet, so no task could be written; record execution receipts first\n");
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // `... | head` closes the pipe mid-write, and the default handler turns that
  // into an unhandled error event and a stack trace printed over the output the
  // reader asked to truncate.
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", (error) => {
      if (/** @type {any} */ (error)?.code !== "EPIPE") throw error;
    });
  }
  process.exitCode = await main(process.argv.slice(2));
}
