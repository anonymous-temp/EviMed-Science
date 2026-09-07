#!/usr/bin/env node
/**
 * Builds one tool dependency graph per capability into `evals/tool-graph/`.
 *
 * The graph is the *proposal* graph: it says which tool could feed which, and
 * how we came to believe it. It is not the graph tasks are built on. That
 * distinction is the whole point of the file, so it is worth being blunt about
 * where each edge comes from:
 *
 *  - `schema` — decidable here. A type an upstream tool's result carries fills
 *    a downstream tool's *required* parameter. Code can settle this, so code
 *    does, and no model is asked.
 *  - `model`  — merged from `evals/tool-graph/model-edges.json`, a side file a
 *    model writes offline. This script never calls a model: a build that
 *    reaches a model produces a different corpus on every run, and a corpus
 *    that regenerates differently is a baseline nobody can compare against.
 *    Whatever `via` that file claims is overwritten with `model`.
 *  - `executed` — merged from `evals/tool-graph/executed-edges.jsonl`, which is
 *    written by the thing that actually ran the pair and carries the run id
 *    that ran it. This script never *establishes* such an edge; it transcribes
 *    a receipt, and refuses any receipt with no run id behind it. That refusal
 *    is the load-bearing part: `executed` is the only source a task may be
 *    built on, so a hand-edited side file that could mint one would turn the
 *    evaluation corpus into fiction.
 *
 * Two rulings a reader will otherwise mistake for oversights:
 *
 * 1. **A capability's graph holds the tools that capability mounts**, not every
 *    tool in the platform. The union in the plan (capability `tools[]` ∪ the
 *    MCP declarations ∪ the kernel tools) is the node *vocabulary*; a graph
 *    containing tools the capability cannot call would generate tasks it cannot
 *    perform, which reads in a report exactly like a capability regression.
 * 2. **A schema edge needs at least one MCP end.** Every generic file tool can
 *    feed every other one, so kernel-to-kernel type matches carry no
 *    information about a capability's workflow while outnumbering everything
 *    that does — and they arrive in pairs (`write` → `edit` → `write`), so the
 *    cycle breaker would then be the thing deciding what the corpus covers.
 *    The suppressed count is written into the output rather than hidden.
 *
 * The kernel tools are declared here as a literal, for the same reason
 * `KERNEL_MOUNTED_TOOL_NAMES` is one: the composition names *plugin packages*,
 * the tools those packages register are a different vocabulary, and deriving
 * one from the other would be a guess wearing the costume of a check. The same
 * goes for `outputSchema`: MCP publishes no output schema, and the return shape
 * is assembled across ten implementation modules, so what a tool produces is
 * declared in `TOOL_OUTPUT_FIELDS` below and marked as our declaration in the
 * emitted node.
 *
 * Usage:
 *   node scripts/dev/build-tool-graph.mjs                       # rebuild every graph
 *   node scripts/dev/build-tool-graph.mjs --capability=adr-analysis
 *   node scripts/dev/build-tool-graph.mjs --out=/tmp/tdg
 *   node scripts/dev/build-tool-graph.mjs --check               # what CI runs
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

import {
  KERNEL_MOUNTED_TOOL_NAMES,
  MCP_MANAGED_JOB_BASE_NAMES,
  TOOL_EDGE_STATE_EFFECTS,
  mcpToolBaseName,
  mcpToolName,
  sanitizeToolGraph,
  validateToolGraph,
} from "@evimed/domain";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Repo-relative where that is readable, absolute where it is not. @param {string} target @returns {string} */
function displayPath(target) {
  const relative = path.relative(repoRoot, target);
  return relative && !relative.startsWith("..") ? relative : target;
}

/** Bumped when the emitted document changes shape, not when a graph changes. */
export const TDG_SCHEMA_VERSION = "1.0.0";

/** The closed type vocabulary the plan fixes. A tag outside it is not a tag. */
export const TOOL_TYPE_TAGS = Object.freeze([
  "pmid", "doi", "nct_id", "drug_name", "mesh_term", "file_path", "dataset_path", "source_id",
]);

/**
 * Parameter name → type tag. A closed table, deliberately: the alternative is a
 * pattern over parameter names, which would tag `productSpecifications` as a
 * drug and `sourceInventory` as a source id, and nobody would notice because a
 * mis-tagged parameter produces an edge that merely looks plausible.
 * @type {Readonly<Record<string, string>>}
 */
const PARAMETER_TYPE_TAGS = Object.freeze({
  pmid: "pmid",
  pmids: "pmid",
  pmcid: "pmid",
  doi: "doi",
  dois: "doi",
  nctId: "nct_id",
  nct_id: "nct_id",
  trialId: "nct_id",
  drug: "drug_name",
  drugs: "drug_name",
  drugAliases: "drug_name",
  candidateDrugs: "drug_name",
  comparator: "drug_name",
  product: "drug_name",
  term: "mesh_term",
  meshTerm: "mesh_term",
  descriptor: "mesh_term",
  file_path: "file_path",
  filePath: "file_path",
  manuscript: "file_path",
  ipdData: "dataset_path",
  datasetPath: "dataset_path",
  userPdfDirectory: "dataset_path",
  source: "source_id",
  sources: "source_id",
  sourceId: "source_id",
  database: "source_id",
  databases: "source_id",
  registry: "source_id",
});

/**
 * Identifier tokens in a tool *description* that name a type the parameter name
 * hides — `identifier` is the only name `open_access_full_text` gives the thing
 * it takes, and the description is where it says the thing is a PMID or a DOI.
 *
 * These are exact, cased, closed tokens over machine-authored metadata, not a
 * pattern over prose: a tool description is written next to the schema by the
 * person who wrote the schema. The distinction matters because "regex never
 * does language" is a rule this file must not be read as breaking.
 * @type {ReadonlyArray<[string, string]>}
 */
const DESCRIPTION_TYPE_TOKENS = Object.freeze([
  ["PMID", "pmid"],
  ["PMCID", "pmid"],
  ["DOI", "doi"],
  ["NCT", "nct_id"],
  ["MeSH", "mesh_term"],
]);

/**
 * What each tool's structured result carries, by field path and type.
 *
 * Declared, not derived. MCP has no `outputSchema` on these tools and the
 * return shape is assembled across `public_sources.py`, `open_access_fulltext.py`,
 * `official_pages.py`, `specialist_jobs.py`, `drug_assessment.py` and five more;
 * scraping that would be a static analysis whose failure mode is a silently
 * missing edge. A field this table does not list is a field no edge depends on.
 * Keys are MCP base names and kernel tool names.
 * @type {Readonly<Record<string, ReadonlyArray<{path: string, type: string}>>>}
 */
const TOOL_OUTPUT_FIELDS = Object.freeze({
  literature_search: [{ path: "items[].pmid", type: "pmid" }, { path: "items[].doi", type: "doi" }],
  guideline_search: [{ path: "items[].doi", type: "doi" }],
  clinical_trial_search: [{ path: "items[].nctId", type: "nct_id" }, { path: "items[].pmid", type: "pmid" }],
  biomedical_source_search: [{ path: "items[].doi", type: "doi" }, { path: "items[].pmid", type: "pmid" }],
  patent_search: [],
  open_access_full_text: [
    { path: "artifacts[].path", type: "file_path" },
    { path: "metadata.doi", type: "doi" },
    { path: "metadata.pmcid", type: "pmid" },
  ],
  official_page_fetch: [{ path: "artifact.path", type: "file_path" }],
  web_search: [],
  geo_visibility_probe: [],
  drug_label_search: [{ path: "items[].drug", type: "drug_name" }],
  pharmacy_reference_search: [{ path: "items[].drug", type: "drug_name" }],
  adr_case_query: [{ path: "items[].drug", type: "drug_name" }],
  adr_signal_analysis: [{ path: "signals[].drug", type: "drug_name" }],
  drug_term_normalize: [{ path: "normalized.term", type: "drug_name" }],
  offlabel_evidence_packet: [{ path: "packet.drug", type: "drug_name" }],
  comprehensive_drug_evaluation: [{ path: "evaluation.drug", type: "drug_name" }],
  drug_selection_evaluation: [{ path: "selection.candidateDrugs[]", type: "drug_name" }],
  meta_analysis: [{ path: "artifacts[].path", type: "file_path" }],
  mendelian_randomization: [{ path: "artifacts[].path", type: "file_path" }],
  bibliometric_analysis: [{ path: "artifacts[].path", type: "file_path" }],
  research_topic_selection: [{ path: "artifacts[].path", type: "file_path" }],
  peer_review: [{ path: "artifacts[].path", type: "file_path" }],
  drug_safety_analysis: [{ path: "artifacts[].path", type: "file_path" }],
  search_papers: [{ path: "items[].doi", type: "doi" }, { path: "items[].pmid", type: "pmid" }],
  search_biomedical_records: [{ path: "items[].doi", type: "doi" }, { path: "items[].pmid", type: "pmid" }],
  search_materials: [],
  get_fred_series: [],
  get_space_weather_alerts: [],
  get_weather: [],
  get_usgs_water_data: [],
  data_source_catalog: [{ path: "sources[].id", type: "source_id" }],
  evidence_deduplicate: [{ path: "items[].doi", type: "doi" }, { path: "items[].pmid", type: "pmid" }],
  term_normalize: [{ path: "normalized.term", type: "mesh_term" }],
  health: [],
  write: [{ path: "path", type: "file_path" }],
  edit: [{ path: "path", type: "file_path" }],
  glob: [{ path: "matches[]", type: "file_path" }],
  grep: [{ path: "matches[].path", type: "file_path" }],
  list: [{ path: "entries[].path", type: "file_path" }],
  fs_write: [{ path: "path", type: "file_path" }],
  fs_edit: [{ path: "path", type: "file_path" }],
  fs_search: [{ path: "matches[].path", type: "file_path" }],
});

/**
 * The kernel tools, as this composition mounts them. Names come from
 * `KERNEL_MOUNTED_TOOL_NAMES`; the parameter shape is declared here because the
 * kernel does not publish its schemas to the control plane, and only the
 * parameters that carry a typed identifier are declared — a fuller guess would
 * be a longer guess.
 * @type {Readonly<Record<string, {description: string, required: string[], optional: string[]}>>}
 */
const KERNEL_TOOL_DECLARATIONS = Object.freeze({
  bash: { description: "Run a shell command in the run workspace.", required: ["command"], optional: [] },
  read: { description: "Read a workspace file, paginated.", required: ["file_path"], optional: ["offset", "limit"] },
  write: { description: "Write a workspace file.", required: ["file_path", "content"], optional: [] },
  edit: { description: "Replace an exact string in a workspace file.", required: ["file_path", "old_string", "new_string"], optional: [] },
  glob: { description: "List workspace paths matching a glob.", required: ["pattern"], optional: ["path"] },
  grep: { description: "Search workspace file contents.", required: ["pattern"], optional: ["path"] },
  list: { description: "List the entries of a workspace directory.", required: ["path"], optional: [] },
  skill: { description: "Load a skill body into the run.", required: ["name"], optional: [] },
  task: { description: "Run a scoped subtask in a fresh context.", required: ["prompt"], optional: ["description"] },
  fs_read: { description: "Read a workspace file through the filesystem plugin.", required: ["path"], optional: [] },
  fs_write: { description: "Write a workspace file through the filesystem plugin.", required: ["path", "content"], optional: [] },
  fs_edit: { description: "Edit a workspace file through the filesystem plugin.", required: ["path"], optional: [] },
  fs_search: { description: "Search the workspace through the filesystem plugin.", required: ["pattern"], optional: ["path"] },
  job_run: { description: "Start a long-running job.", required: ["command"], optional: [] },
  job_status: { description: "Poll a started job.", required: ["jobId"], optional: [] },
  ask_user: { description: "Ask the operator a question.", required: ["question"], optional: [] },
  subagent: { description: "Delegate to a child agent.", required: ["task"], optional: [] },
  subagent_control: { description: "Steer or stop a child agent.", required: ["id", "action"], optional: [] },
  subagent_report: { description: "Read a child agent's report.", required: ["id"], optional: [] },
  workflow: { description: "Run a declared workflow.", required: ["name"], optional: [] },
});

/**
 * A tag outside the vocabulary is not a tag, and a mistyped one is worse than a
 * missing one: it produces no edge and no complaint, so the corpus silently
 * loses a task family and the build still says it succeeded. Checked at load,
 * where the failure is loud.
 */
for (const [parameter, tag] of Object.entries(PARAMETER_TYPE_TAGS)) {
  if (!TOOL_TYPE_TAGS.includes(tag)) throw new Error(`parameter ${parameter} is tagged ${tag}, which is not in the type vocabulary`);
}
for (const [token, tag] of DESCRIPTION_TYPE_TOKENS) {
  if (!TOOL_TYPE_TAGS.includes(tag)) throw new Error(`description token ${token} is tagged ${tag}, which is not in the type vocabulary`);
}
for (const [tool, fields] of Object.entries(TOOL_OUTPUT_FIELDS)) {
  for (const field of fields) {
    if (!TOOL_TYPE_TAGS.includes(field.type)) throw new Error(`${tool} declares output ${field.path} as ${field.type}, which is not in the type vocabulary`);
  }
}

/** Tools whose execution leaves a file behind, so a fixture must be reset after them. */
const WORKSPACE_WRITERS = new Set([
  "write", "edit", "fs_write", "fs_edit", "bash", "job_run",
  mcpToolName("open_access_full_text"), mcpToolName("official_page_fetch"),
]);

/** Tools whose execution spends budget through the usage ledger. */
const LEDGER_WRITERS = new Set(MCP_MANAGED_JOB_BASE_NAMES.map((base) => mcpToolName(base)));

/* ------------------------------------------------------------------ typing */

/**
 * Every property name anywhere in a JSON schema subtree.
 * @param {unknown} schema
 * @param {Set<string>} [into]
 * @returns {Set<string>}
 */
export function schemaPropertyNames(schema, into = new Set()) {
  if (!schema || typeof schema !== "object") return into;
  const node = /** @type {Record<string, any>} */ (schema);
  if (node.properties && typeof node.properties === "object") {
    for (const [name, child] of Object.entries(node.properties)) {
      into.add(name);
      schemaPropertyNames(child, into);
    }
  }
  if (node.items) schemaPropertyNames(node.items, into);
  return into;
}

/**
 * The type tags a set of property names carries, through the closed table.
 * @param {Iterable<string>} names
 * @returns {string[]}
 */
function tagsForNames(names) {
  const tags = new Set();
  for (const name of names) {
    const tag = PARAMETER_TYPE_TAGS[name];
    if (tag) tags.add(tag);
  }
  return [...tags].sort();
}

/**
 * The type tags a tool's description names outright.
 * @param {string} description
 * @returns {string[]}
 */
function tagsForDescription(description) {
  const text = String(description ?? "");
  const tags = new Set();
  for (const [token, tag] of DESCRIPTION_TYPE_TOKENS) {
    if (text.includes(token)) tags.add(tag);
  }
  return [...tags].sort();
}

/**
 * The tags a caller must already hold to satisfy this tool's required inputs.
 *
 * A tag on an optional parameter is not a dependency: the tool runs without it,
 * so an edge built on one would order two tools that need no ordering.
 * @param {unknown} inputSchema
 * @param {string} description
 * @returns {string[]}
 */
export function requiredTypeTags(inputSchema, description) {
  const schema = /** @type {Record<string, any>} */ (inputSchema ?? {});
  const required = Array.isArray(schema.required) ? schema.required : [];
  const names = new Set();
  for (const name of required) {
    names.add(name);
    schemaPropertyNames(schema.properties?.[name], names);
  }
  const tags = new Set(tagsForNames(names));
  // A description tag only counts as required when the tool has exactly one
  // required parameter and that parameter is untyped by name — the
  // `open_access_full_text(identifier)` case, and the only one worth the risk
  // of reading a sentence as a schema.
  if (required.length === 1 && !tagsForNames([required[0]]).length) {
    for (const tag of tagsForDescription(description)) tags.add(tag);
  }
  return [...tags].sort();
}

/**
 * @param {string} name
 * @returns {string}
 */
function stateEffect(name) {
  if (LEDGER_WRITERS.has(name)) return "writes_ledger";
  if (WORKSPACE_WRITERS.has(name)) return "writes_workspace";
  return "none";
}

/** Strongest effect either end of a pair has; that is what decides a reset. */
function pairStateEffect(from, to) {
  const rank = (effect) => TOOL_EDGE_STATE_EFFECTS.indexOf(effect);
  const left = stateEffect(from);
  const right = stateEffect(to);
  return rank(left) >= rank(right) ? left : right;
}

/* ------------------------------------------------------------------- nodes */

/**
 * @typedef {object} ToolDeclaration
 * @property {string} name
 * @property {string} [description]
 * @property {unknown} [inputSchema]
 */

/**
 * Build one node from a declaration.
 * @param {string} name
 * @param {string} source
 * @param {string} description
 * @param {unknown} inputSchema
 * @param {string} outputKey
 * @returns {import('@evimed/domain').ToolGraphNode}
 */
function buildNode(name, source, description, inputSchema, outputKey) {
  const fields = TOOL_OUTPUT_FIELDS[outputKey] ?? [];
  const typeTags = [...new Set([
    ...tagsForNames(schemaPropertyNames(inputSchema)),
    ...tagsForDescription(description),
  ])].sort();
  return /** @type {any} */ ({
    name,
    source,
    description,
    inputSchema,
    outputSchema: {
      type: "object",
      declaredBy: "scripts/dev/build-tool-graph.mjs",
      note: "MCP publishes no output schema for this tool; these are the result fields an edge may depend on.",
      fields: fields.map((field) => ({ path: field.path, type: field.type })),
    },
    typeTags,
    requiredTypeTags: requiredTypeTags(inputSchema, description),
    outputTypeTags: [...new Set(fields.map((field) => field.type))].sort(),
    stateEffect: stateEffect(name),
  });
}

/**
 * The kernel nodes every run carries, whatever the capability mounts.
 * @returns {import('@evimed/domain').ToolGraphNode[]}
 */
export function kernelNodes() {
  return KERNEL_MOUNTED_TOOL_NAMES.map((name) => {
    const declaration = KERNEL_TOOL_DECLARATIONS[name];
    if (!declaration) throw new Error(`kernel tool ${name} is mounted but undeclared in build-tool-graph.mjs`);
    /** @type {Record<string, any>} */
    const properties = {};
    for (const parameter of [...declaration.required, ...declaration.optional]) {
      properties[parameter] = { type: "string" };
    }
    const inputSchema = {
      type: "object",
      declaredBy: "scripts/dev/build-tool-graph.mjs",
      properties,
      required: [...declaration.required],
    };
    return buildNode(name, "kernel", declaration.description, inputSchema, name);
  }).sort((left, right) => left.name.localeCompare(right.name));
}

/* ------------------------------------------------------------------- edges */

/**
 * `confidence` in an emitted graph is a *retention priority*, not a probability.
 *
 * The cycle breaker in `sanitizeToolGraph` picks what to delete by confidence,
 * and it does not know how an edge was established. Left alone it would resolve
 * a two-cycle between an execution receipt and a type match by coin-flipping on
 * the edge label — and dropping the receipt is the one outcome that must never
 * happen, because the receipt is the only thing a task may be built on. So each
 * source gets a band, the bands do not overlap, and a model's own score is
 * scaled into its band so its relative ordering survives without ever outranking
 * something decidable.
 */
const EXECUTED_CONFIDENCE = 1;
const SCHEMA_CONFIDENCE = 0.9;
const MODEL_CONFIDENCE_FLOOR = 0.1;
const MODEL_CONFIDENCE_CEILING = 0.8;

/** @param {unknown} raw @returns {number} */
function modelConfidence(raw) {
  const value = typeof raw === "number" && raw >= 0 && raw <= 1 ? raw : 0.5;
  const scaled = MODEL_CONFIDENCE_FLOOR + (MODEL_CONFIDENCE_CEILING - MODEL_CONFIDENCE_FLOOR) * value;
  return Number(scaled.toFixed(4));
}

/**
 * Schema edges: a type one tool produces fills a required parameter of another.
 *
 * Kernel-to-kernel pairs are suppressed rather than emitted; the count is
 * returned so the output can say how many and why.
 * @param {readonly import('@evimed/domain').ToolGraphNode[]} nodes
 * @returns {{edges: import('@evimed/domain').ToolGraphEdge[], suppressed: number}}
 */
export function schemaEdges(nodes) {
  /** @type {import('@evimed/domain').ToolGraphEdge[]} */
  const edges = [];
  let suppressed = 0;
  for (const from of nodes) {
    const produces = new Set(/** @type {any} */ (from).outputTypeTags ?? []);
    if (!produces.size) continue;
    for (const to of nodes) {
      if (to.name === from.name) continue;
      const needs = /** @type {string[]} */ (/** @type {any} */ (to).requiredTypeTags ?? []);
      const matched = needs.filter((tag) => produces.has(tag)).sort();
      if (!matched.length) continue;
      if (/** @type {any} */ (from).source === "kernel" && /** @type {any} */ (to).source === "kernel") {
        suppressed += 1;
        continue;
      }
      edges.push(/** @type {any} */ ({
        from: from.name,
        to: to.name,
        type: "parameter",
        via: "schema",
        confidence: SCHEMA_CONFIDENCE,
        validatedBy: null,
        stateEffect: pairStateEffect(from.name, to.name),
        matchedTypes: matched,
      }));
    }
  }
  return { edges, suppressed };
}

/** Trust order for collapsing two edges between the same pair. */
const VIA_RANK = { model: 0, schema: 1, executed: 2 };

/**
 * Keep one edge per ordered pair: the better-established source wins, and a
 * parameter edge beats a semantic one at equal standing.
 * @param {readonly import('@evimed/domain').ToolGraphEdge[]} edges
 * @returns {{edges: import('@evimed/domain').ToolGraphEdge[], removed: {edge: import('@evimed/domain').ToolGraphEdge, reason: string}[]}}
 */
export function collapseParallelEdges(edges) {
  /** @type {Map<string, import('@evimed/domain').ToolGraphEdge>} */
  const held = new Map();
  /** @type {{edge: import('@evimed/domain').ToolGraphEdge, reason: string}[]} */
  const removed = [];
  const better = (left, right) => {
    const rank = (edge) => VIA_RANK[edge.via] ?? -1;
    if (rank(left) !== rank(right)) return rank(left) > rank(right);
    if ((left.type === "parameter") !== (right.type === "parameter")) return left.type === "parameter";
    return (left.confidence ?? 0) >= (right.confidence ?? 0);
  };
  for (const edge of edges) {
    const key = `${edge.from}->${edge.to}`;
    const current = held.get(key);
    if (!current) {
      held.set(key, edge);
      continue;
    }
    const keep = better(edge, current) ? edge : current;
    const drop = keep === edge ? current : edge;
    held.set(key, keep);
    removed.push({ edge: drop, reason: `superseded by the ${keep.via} edge between the same pair` });
  }
  return { edges: [...held.values()], removed };
}

/* ---------------------------------------------------------------- side files */

/**
 * Model-proposed edges. The `via` a side file claims is ignored: a file a human
 * or a model writes may propose an ordering, never certify one.
 * @param {string} text
 * @param {string} capability
 * @returns {{edges: import('@evimed/domain').ToolGraphEdge[], failures: string[]}}
 */
export function readModelEdges(text, capability) {
  /** @type {string[]} */
  const failures = [];
  /** @type {import('@evimed/domain').ToolGraphEdge[]} */
  const edges = [];
  let document;
  try {
    document = JSON.parse(text);
  } catch (error) {
    return { edges, failures: [`model-edges: unreadable — ${error instanceof Error ? error.message : String(error)}`] };
  }
  for (const [index, raw] of (document?.edges ?? []).entries()) {
    if (raw?.capability && raw.capability !== capability) continue;
    if (!raw?.from || !raw?.to) {
      failures.push(`model-edges[${index}]: an edge needs both ends`);
      continue;
    }
    if (raw.via && raw.via !== "model") {
      failures.push(`model-edges[${index}]: claims via "${raw.via}"; a proposal file may only carry model edges`);
      continue;
    }
    edges.push(/** @type {any} */ ({
      from: String(raw.from),
      to: String(raw.to),
      type: raw.type === "parameter" ? "parameter" : "semantic",
      via: "model",
      confidence: modelConfidence(raw.confidence),
      validatedBy: null,
      stateEffect: pairStateEffect(String(raw.from), String(raw.to)),
      ...(raw.rationale ? { rationale: String(raw.rationale) } : {}),
    }));
  }
  return { edges, failures };
}

/**
 * Execution receipts. Each line is one pair somebody actually ran, and the run
 * id is mandatory: without it the line is an assertion, and an assertion that
 * mints a sampleable edge is how an evaluation corpus starts testing a claim
 * instead of a system.
 * @param {string} text
 * @param {string} capability
 * @returns {{edges: import('@evimed/domain').ToolGraphEdge[], failures: string[]}}
 */
export function readExecutedEdges(text, capability) {
  /** @type {string[]} */
  const failures = [];
  /** @type {import('@evimed/domain').ToolGraphEdge[]} */
  const edges = [];
  for (const [index, line] of String(text ?? "").split("\n").entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let raw;
    try {
      raw = JSON.parse(trimmed);
    } catch (error) {
      failures.push(`executed-edges:${index + 1}: unreadable — ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (raw?.capability && raw.capability !== capability) continue;
    if (!raw?.from || !raw?.to) {
      failures.push(`executed-edges:${index + 1}: an edge needs both ends`);
      continue;
    }
    if (!raw?.validatedBy) {
      failures.push(`executed-edges:${index + 1}: ${raw.from} -> ${raw.to} records no run id, so nothing proves the pair ever ran`);
      continue;
    }
    edges.push(/** @type {any} */ ({
      from: String(raw.from),
      to: String(raw.to),
      type: raw.type === "semantic" ? "semantic" : "parameter",
      via: "executed",
      confidence: EXECUTED_CONFIDENCE,
      validatedBy: String(raw.validatedBy),
      stateEffect: pairStateEffect(String(raw.from), String(raw.to)),
    }));
  }
  return { edges, failures };
}

/* ------------------------------------------------------------------- build */

/**
 * @param {readonly unknown[]} value
 * @returns {string}
 */
function digestOf(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`;
}

/**
 * @param {import('@evimed/domain').ToolGraphEdge} edge
 * @returns {string}
 */
function edgeKey(edge) {
  return `${edge.from}\u0000${edge.to}\u0000${edge.type}\u0000${edge.via}`;
}

/**
 * Build one capability's graph.
 * @param {object} options
 * @param {string} options.capability
 * @param {readonly string[]} options.tools capability.yaml `tools[]`, model-visible names
 * @param {Map<string, ToolDeclaration>} options.declarations MCP declarations, by base name
 * @param {string} options.modelEdgesText
 * @param {string} options.executedEdgesText
 * @returns {{document: any, failures: string[]}}
 */
export function buildCapabilityGraph(options) {
  const { capability, tools, declarations, modelEdgesText, executedEdgesText } = options;
  /** @type {string[]} */
  const failures = [];
  /** @type {import('@evimed/domain').ToolGraphNode[]} */
  const nodes = [];
  for (const tool of [...new Set(tools)].sort()) {
    const base = mcpToolBaseName(tool);
    if (!base) {
      failures.push(`${capability}: tools[] names ${JSON.stringify(tool)}, which is not an EviMed research tool`);
      continue;
    }
    const declaration = declarations.get(base);
    if (!declaration) {
      failures.push(`${capability}: tools[] names ${base}, which the MCP server does not publish`);
      continue;
    }
    nodes.push(buildNode(mcpToolName(base), "mcp", String(declaration.description ?? ""), declaration.inputSchema ?? {}, base));
  }
  nodes.push(...kernelNodes());
  nodes.sort((left, right) => left.name.localeCompare(right.name));

  const names = new Set(nodes.map((node) => node.name));
  const { edges: schemaProposed, suppressed } = schemaEdges(nodes);
  const model = readModelEdges(modelEdgesText, capability);
  const executed = readExecutedEdges(executedEdgesText, capability);
  failures.push(...model.failures.map((line) => `${capability}: ${line}`));
  failures.push(...executed.failures.map((line) => `${capability}: ${line}`));

  /** @type {{edge: import('@evimed/domain').ToolGraphEdge, reason: string}[]} */
  const removed = [];
  /** @type {import('@evimed/domain').ToolGraphEdge[]} */
  const proposed = [];
  for (const edge of [...executed.edges, ...schemaProposed, ...model.edges]) {
    if (!names.has(edge.from) || !names.has(edge.to)) {
      removed.push({ edge, reason: "names a tool this capability does not mount" });
      continue;
    }
    proposed.push(edge);
  }
  const collapsed = collapseParallelEdges(proposed);
  removed.push(...collapsed.removed);

  const sanitized = sanitizeToolGraph({ capability, nodes, edges: collapsed.edges }, { requireExecuted: false });
  removed.push(...sanitized.removed);
  const edges = [...sanitized.graph.edges].sort((left, right) => edgeKey(left).localeCompare(edgeKey(right)));

  const validation = validateToolGraph({ capability, nodes, edges });
  failures.push(...validation.issues.map((issue) => `${capability}: ${issue.code}: ${issue.message}`));

  const counts = { schema: 0, model: 0, executed: 0 };
  for (const edge of edges) counts[edge.via] = (counts[edge.via] ?? 0) + 1;

  const document = {
    schemaVersion: TDG_SCHEMA_VERSION,
    capability,
    version: digestOf([nodes, edges]),
    generatedBy: "scripts/dev/build-tool-graph.mjs",
    counts: {
      nodes: nodes.length,
      edges: edges.length,
      byVia: counts,
      sampleable: counts.executed,
    },
    // Written into the corpus so a diff can explain itself: a graph that lost a
    // task family should say whether an edge was dropped and why, rather than
    // leaving the reader to diff two task sets and guess.
    suppressed: [
      {
        reason: "kernel-to-kernel type match; every file tool can feed every other, so the pair says nothing about this capability",
        count: suppressed,
      },
    ],
    removed: removed
      .map((entry) => ({ from: entry.edge.from, to: entry.edge.to, type: entry.edge.type, via: entry.edge.via, reason: entry.reason }))
      .sort((left, right) => `${left.from}->${left.to}:${left.via}`.localeCompare(`${right.from}->${right.to}:${right.via}`)),
    nodes,
    edges,
  };
  return { document, failures };
}

/* ------------------------------------------------------- MCP declarations */

/**
 * Ask the MCP server what it publishes, over its own stdio protocol.
 *
 * `EVIMED_DISABLED_TOOLS` is cleared first: a deployment that switches a tool
 * off must not be able to rewrite the committed corpus by running the build.
 * @param {string} [serverPath]
 * @returns {ToolDeclaration[]}
 */
export function readMcpDeclarations(serverPath = path.join(repoRoot, "runtime/mcp/evimed-research/server.py")) {
  const env = { ...process.env };
  delete env.EVIMED_DISABLED_TOOLS;
  const frame = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })}\n`;
  const run = spawnSync("python3", [serverPath], { input: frame, encoding: "utf8", env, maxBuffer: 32 * 1024 * 1024 });
  if (run.error) throw new Error(`cannot start the MCP server with python3: ${run.error.message}`);
  if (run.status !== 0) throw new Error(`the MCP server exited ${run.status}: ${String(run.stderr).trim()}`);
  const line = String(run.stdout).split("\n").find((entry) => entry.trim());
  if (!line) throw new Error("the MCP server answered tools/list with nothing");
  const response = JSON.parse(line);
  const tools = response?.result?.tools;
  if (!Array.isArray(tools)) throw new Error("the MCP tools/list response carried no tools array");
  return tools;
}

/* --------------------------------------------------------------------- cli */

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

const HELP = `build-tool-graph — one tool dependency graph per capability

  node scripts/dev/build-tool-graph.mjs [options]

  --capability=<id>     build only this capability; repeatable, default all
  --capabilities=<dir>  where capability.yaml lives (default: capabilities)
  --out=<dir>           where the graphs are written (default: evals/tool-graph)
  --tools=<file>        MCP tools/list dump to use instead of starting the server
  --model-edges=<file>  model-proposed edges (default: evals/tool-graph/model-edges.json)
  --executed-edges=<f>  execution receipts (default: evals/tool-graph/executed-edges.jsonl)
  --check               verify the committed graphs, write nothing, exit 1 on drift
  --help                this text

Only an edge with an execution receipt may carry a task; schema and model edges
are recorded as proposals and are refused by the brief generator.
`;

/**
 * Compare a built document against what is on disk and describe the drift.
 * @param {any} expected
 * @param {string | null} actualText
 * @returns {string[]}
 */
export function graphDrift(expected, actualText) {
  if (actualText == null) return ["not committed; run without --check"];
  let actual;
  try {
    actual = JSON.parse(actualText);
  } catch {
    return ["committed file is not valid JSON"];
  }
  /** @type {string[]} */
  const lines = [];
  if (actual.version !== expected.version) lines.push(`version ${actual.version} → ${expected.version}`);
  const nodeNames = (document) => new Set((document.nodes ?? []).map((node) => node.name));
  const before = nodeNames(actual);
  const after = nodeNames(expected);
  const missing = (from, held) => [...from].filter((entry) => !held.has(entry)).sort();
  for (const name of missing(after, before)) lines.push(`+ node ${name}`);
  for (const name of missing(before, after)) lines.push(`- node ${name}`);
  const edgeLabels = (document) => new Set((document.edges ?? []).map((edge) => `${edge.from} -> ${edge.to} (${edge.type}/${edge.via})`));
  const edgesBefore = edgeLabels(actual);
  const edgesAfter = edgeLabels(expected);
  for (const label of missing(edgesAfter, edgesBefore)) lines.push(`+ edge ${label}`);
  for (const label of missing(edgesBefore, edgesAfter)) lines.push(`- edge ${label}`);
  if (!lines.length && JSON.stringify(actual) !== JSON.stringify(expected)) {
    lines.push("same nodes and edges but a different document; a field outside the graph moved");
  }
  return lines;
}

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
  const check = args.has("check");
  const sourceDir = path.resolve(repoRoot, args.get("capabilities")?.[0] || "capabilities");
  const outDir = path.resolve(repoRoot, args.get("out")?.[0] || "evals/tool-graph");
  const modelEdgesPath = path.resolve(repoRoot, args.get("model-edges")?.[0] || "evals/tool-graph/model-edges.json");
  const executedEdgesPath = path.resolve(repoRoot, args.get("executed-edges")?.[0] || "evals/tool-graph/executed-edges.jsonl");
  const only = (args.get("capability") ?? []).filter(Boolean);

  const declarations = new Map();
  const toolsFile = args.get("tools")?.[0];
  let published;
  try {
    published = toolsFile
      ? JSON.parse(await fs.readFile(path.resolve(repoRoot, toolsFile), "utf8"))
      : readMcpDeclarations();
  } catch (error) {
    process.stderr.write(`cannot read the MCP tool declarations: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (!Array.isArray(published)) {
    process.stderr.write(`${toolsFile}: expected an array of tool declarations\n`);
    return 1;
  }
  for (const tool of published) declarations.set(tool.name, tool);

  const modelEdgesText = await fs.readFile(modelEdgesPath, "utf8").catch(() => '{"edges":[]}');
  const executedEdgesText = await fs.readFile(executedEdgesPath, "utf8").catch(() => "");

  const entries = await fs.readdir(sourceDir, { withFileTypes: true }).catch(() => []);
  const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  if (!directories.length) {
    process.stderr.write(`no capabilities under ${sourceDir}\n`);
    return 1;
  }
  const unknown = only.filter((name) => !directories.includes(name));
  if (unknown.length) {
    process.stderr.write(`no such capability: ${unknown.join(", ")}\n`);
    return 1;
  }

  /** @type {string[]} */
  const failures = [];
  /** @type {{id: string, json: string, document: any}[]} */
  const built = [];
  /** @type {string[]} */
  const skipped = [];

  for (const name of directories) {
    if (only.length && !only.includes(name)) continue;
    const manifestPath = path.join(sourceDir, name, "capability.yaml");
    let manifest;
    try {
      manifest = parseYaml(await fs.readFile(manifestPath, "utf8"));
    } catch (error) {
      failures.push(`${name}: capability.yaml is unreadable — ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (manifest?.id && manifest.id !== name) {
      failures.push(`${name}: manifest id "${manifest.id}" does not match its directory`);
      continue;
    }
    const tools = Array.isArray(manifest?.tools) ? manifest.tools.map(String) : [];
    if (!tools.length) {
      // A kernel-only graph has no edges to walk and would produce briefs made
      // of isolated file operations, which is not what this capability does.
      skipped.push(`${name}: declares no tools`);
      continue;
    }
    const result = buildCapabilityGraph({ capability: name, tools, declarations, modelEdgesText, executedEdgesText });
    failures.push(...result.failures);
    built.push({ id: name, json: `${JSON.stringify(result.document, null, 2)}\n`, document: result.document });
  }

  if (failures.length) {
    process.stderr.write(`tool graphs rejected:\n${failures.map((line) => `  - ${line}`).join("\n")}\n`);
    return 1;
  }

  if (check) {
    let drifted = false;
    for (const graph of built) {
      const target = path.join(outDir, `tdg.${graph.id}.json`);
      const current = await fs.readFile(target, "utf8").catch(() => null);
      if (current === graph.json) continue;
      drifted = true;
      process.stderr.write(`out of date: ${displayPath(target)}\n`);
      for (const line of graphDrift(graph.document, current)) process.stderr.write(`    ${line}\n`);
    }
    if (!only.length) {
      const present = (await fs.readdir(outDir).catch(() => [])).filter((file) => /^tdg\..+\.json$/.test(file));
      for (const file of present) {
        if (built.some((graph) => `tdg.${graph.id}.json` === file)) continue;
        drifted = true;
        process.stderr.write(`orphaned: ${displayPath(path.join(outDir, file))} has no capability behind it\n`);
      }
    }
    if (drifted) {
      process.stderr.write("run `node scripts/dev/build-tool-graph.mjs` and commit the result\n");
      return 1;
    }
    process.stdout.write(`${built.length} tool graph(s) up to date\n`);
    return 0;
  }

  await fs.mkdir(outDir, { recursive: true });
  if (!only.length) {
    const present = (await fs.readdir(outDir).catch(() => [])).filter((file) => /^tdg\..+\.json$/.test(file));
    for (const file of present) {
      if (!built.some((graph) => `tdg.${graph.id}.json` === file)) await fs.rm(path.join(outDir, file));
    }
  }
  for (const graph of built) await fs.writeFile(path.join(outDir, `tdg.${graph.id}.json`), graph.json, "utf8");

  process.stdout.write(`${built.length} tool graph(s) written to ${displayPath(outDir)}\n`);
  for (const graph of built) {
    const counts = graph.document.counts;
    process.stdout.write(
      `  ${graph.id}: ${counts.nodes} nodes, ${counts.edges} edges `
      + `(${counts.byVia.schema ?? 0} schema, ${counts.byVia.model ?? 0} model, ${counts.byVia.executed ?? 0} executed), `
      + `${counts.sampleable} sampleable\n`,
    );
  }
  for (const line of skipped) process.stdout.write(`  skipped ${line}\n`);
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
