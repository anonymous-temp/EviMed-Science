/**
 * Which tool actually fed which, and in what order, read off a finished run.
 *
 * Hidden knowledge: `evals/tool-graph/` holds a capability graph per capability and every edge in them was `via: "schema"` — a
 * type an upstream tool *could* produce filling a parameter a downstream tool requires — until this producer existed; `executed`
 * is the only source a task may be built on, and nothing wrote one. The receipts below are written for every finished run, and
 * merged into the corpus by hand (`scripts/dev/collect-executed-edges.mjs`); the corpus the evaluation harness was to build tasks
 * from (`generate-briefs.mjs`, deleted 2026-10-23, never produced a brief) is gone, and the graphs' own consumer is the 循证进化
 * opportunity de-duplication. The second half of the file, the tool traces, is read by the learning loop.
 *
 * This reads the artefact we already keep: the run transcript. The claim the edge receipts make is deliberately the narrow,
 * decidable one —
 *
 *   tool A's result carried an identifier, and a later tool B's input used it.
 *
 * — because that is a fact code can settle. Whether B *semantically* depends on A is a judgement, and a judgement recorded as a
 * receipt is how an evaluation corpus starts testing a claim instead of a system. This file never emits a `semantic` edge for that
 * reason.
 *
 * Three refusals, each of which would otherwise mint an edge that is not there:
 *
 *  - **An identifier that arrived from outside is never attributed.** If a DOI
 *    appears in a tool's *input* before any tool's output produced it, the
 *    brief supplied it, and every later use of it proves nothing about tool
 *    ordering. Once external, always external — a value that also turns up in
 *    some later output is ambiguous, and ambiguous is not evidence.
 *  - **A failed call produces nothing.** An edge means the pair ran and worked.
 *  - **A tool never feeds itself.** Two calls to the same search tool passing
 *    identifiers along is one tool being used twice, not a dependency.
 *
 * Identifiers come from `referenceIdentifiers` in the delivery-gate module
 * rather than a private copy, because "are these two strings the same article"
 * already has an answer in this codebase and a second one would drift.
 * Workspace paths are added here, since a file one tool wrote and another read
 * is the commonest real dependency in these runs and is not bibliographic.
 *
 * @module
 */

import path from "node:path";

import { referenceIdentifiers } from "@evimed/domain/clinical-evidence";

import { readTextFileNoFollow, withProjectStorageMutation, writeFileAtomicNoFollow } from "./security.mjs";

/** How many characters of one tool result are scanned for identifiers. */
const MAX_SCANNED_CHARS = 200_000;

/** How many receipts one run may contribute, so a pathological run cannot
 *  flood the corpus it is supposed to describe. */
export const MAX_EDGES_PER_RUN = 200;

/**
 * A workspace-relative artefact path, as tools write and name them.
 *
 * Anchored on a real extension rather than on "has a slash": prose about
 * `evidence/screening` is not a path, and a rule that treats it as one invents
 * dependencies out of sentences.
 *
 * `jsonl` precedes `json` in the alternation and the match ends on a boundary,
 * both for the same reason a test caught: without them `evidence/rows.jsonl`
 * matched as `evidence/rows.json`, so two different files became one
 * identifier and a tool that read one would be recorded as having consumed the
 * other's output.
 */
const ARTEFACT_PATH = /(?:^|[\s"'([,:=])((?:[\w.-]+\/){1,6}[\w.-]+\.(?:jsonl|json|md|csv|tsv|bib|txt|yaml|yml|png|pdf|docx|xlsx))(?![\w.])/g;

/** @param {unknown} value @returns {string} */
function asText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.slice(0, MAX_SCANNED_CHARS);
  try {
    return JSON.stringify(value).slice(0, MAX_SCANNED_CHARS);
  } catch {
    return "";
  }
}

/**
 * Every identifier a value carries, in one normalised vocabulary.
 * @param {unknown} value
 * @returns {Set<string>}
 */
export function carriedIdentifiers(value) {
  const text = asText(value);
  if (!text) return new Set();
  const found = referenceIdentifiers(text);
  for (const [, artefact] of text.matchAll(ARTEFACT_PATH)) found.add(`path:${artefact}`);
  return found;
}

/**
 * The completed tool calls of one session, in the order they completed.
 *
 * Ordered by the kernel's own sequence where it publishes one, and by transcript
 * order otherwise. Ordering is the whole basis of the claim — "A then B" read
 * off a list that is not in time order is not evidence of anything — so a
 * session whose parts carry no ordering at all still yields transcript order,
 * which is the order the kernel wrote them in.
 *
 * Reads the *normalized* `RunTranscript` vocabulary — `part.status`,
 * `part.input`, `part.output`, `message.turn` — because that is what
 * `runtimeManager.sessionTranscript` returns and therefore what
 * `collectRunTranscripts` hands this module. The ledger's own shape nests the
 * same fields under `part.state` (`transcriptToLedgerMessages` builds it), and
 * reading that shape here finds no tool call in any real run while every test
 * written against the same wrong assumption stays green. This module did
 * exactly that until it was checked against the adapter.
 *
 * @param {{transcript?: any}} session
 * @returns {{tool: string, input: unknown, output: unknown, turn: number}[]}
 */
export function completedToolCalls(session) {
  /** @type {{tool: string, input: unknown, output: unknown, turn: number, seq: number}[]} */
  const calls = [];
  let index = 0;
  for (const message of session?.transcript?.messages ?? []) {
    for (const part of message?.parts ?? []) {
      index += 1;
      if (part?.type !== "tool" || part?.status !== "completed" || part?.error) continue;
      const tool = String(part?.tool ?? "");
      if (!tool) continue;
      calls.push({
        tool,
        input: part.input,
        output: part.output,
        turn: Number(message?.turn) || 0,
        seq: Number(part.completedSeq) || index,
      });
    }
  }
  return calls.sort((left, right) => left.seq - right.seq).map(({ seq: _seq, ...call }) => call);
}

/**
 * @typedef {object} ExecutedEdgeReceipt
 * @property {string} capability
 * @property {string} from
 * @property {string} to
 * @property {"parameter"} type
 * @property {string} validatedBy   the run id that ran the pair
 * @property {string[]} matchedIdentifiers  what flowed, for a reader checking the claim
 */

/**
 * Derive one run's execution receipts.
 *
 * Per session, because a value that crossed from one child to another crossed
 * through a deliverable and a gate rather than through a tool call, and calling
 * that a tool dependency would put the workflow's structure into the tool
 * graph. The capability is the session's own; a session with none is skipped
 * rather than filed under the parent's, since the receipt's whole use is to
 * say which capability's graph the edge belongs in.
 *
 * @param {{runId: string, sessions: readonly any[], capability?: string}} input
 * @returns {ExecutedEdgeReceipt[]}
 */
export function executedToolEdges(input) {
  const runId = String(input.runId ?? "");
  /** @type {Map<string, ExecutedEdgeReceipt>} */
  const edges = new Map();
  if (!runId) return [];

  for (const session of input.sessions ?? []) {
    const capability = String(session?.capability ?? input.capability ?? "");
    if (!capability) continue;
    /** @type {Map<string, string>} */
    const producedBy = new Map();
    /** @type {Set<string>} */
    const external = new Set();

    for (const call of completedToolCalls(session)) {
      for (const identifier of carriedIdentifiers(call.input)) {
        const source = producedBy.get(identifier);
        if (!source) {
          // Nothing has produced it yet, so it came in with the brief.
          external.add(identifier);
          continue;
        }
        if (external.has(identifier) || source === call.tool) continue;
        const key = `${capability}\u0000${source}\u0000${call.tool}`;
        const existing = edges.get(key);
        if (existing) {
          if (!existing.matchedIdentifiers.includes(identifier) && existing.matchedIdentifiers.length < 8) {
            existing.matchedIdentifiers.push(identifier);
          }
          continue;
        }
        edges.set(key, {
          capability,
          from: source,
          to: call.tool,
          type: "parameter",
          validatedBy: runId,
          matchedIdentifiers: [identifier],
        });
      }
      for (const identifier of carriedIdentifiers(call.output)) {
        if (!producedBy.has(identifier)) producedBy.set(identifier, call.tool);
      }
    }
  }
  return [...edges.values()].slice(0, MAX_EDGES_PER_RUN);
}

/**
 * The receipts as the corpus file stores them: one JSON object per line, sorted
 * so two runs over the same workflow produce comparable files.
 * @param {readonly ExecutedEdgeReceipt[]} receipts
 * @returns {string}
 */
export function serializeExecutedEdges(receipts) {
  const lines = [...receipts]
    .sort((left, right) => `${left.capability}${left.from}${left.to}`.localeCompare(`${right.capability}${right.from}${right.to}`, "en"))
    .map((receipt) => JSON.stringify(receipt));
  return lines.length ? `${lines.join("\n")}\n` : "";
}

/** Where one project's receipts live, beside its transcripts. */
export const TOOL_EDGE_DIR_NAME = "tool-edges";

/** @param {{ metaDir: string }} project @param {string} runId @returns {string} */
export function toolEdgePath(project, runId) {
  return path.join(project.metaDir, TOOL_EDGE_DIR_NAME, `${runId.replace(/[^A-Za-z0-9_-]/g, "_")}.jsonl`);
}

/**
 * Write one run's receipts, and say how many there were.
 *
 * One file per run rather than an append to a shared one: two runs finishing
 * together would interleave lines in a shared file, and a half-written JSON
 * object in a corpus that decides what gets evaluated is worse than no corpus.
 * Merging is a separate, explicit step (`scripts/dev/collect-executed-edges.mjs`).
 *
 * The absolute path goes to the scoped writer, never the project-relative one —
 * `writeFileAtomicNoFollow` resolves against the process working directory, so
 * a relative path lands outside the workspace and is refused as
 * `path_forbidden` on every single call, which is exactly how the transcript
 * writer silently recorded nothing until it was caught.
 *
 * @param {{project: any, run: {id: string}, sessions: readonly any[]}} input
 * @returns {Promise<{path: string | null, edges: number}>}
 */
export async function persistExecutedToolEdges({ project, run, sessions }) {
  const receipts = executedToolEdges({ runId: run.id, sessions });
  if (!receipts.length) return { path: null, edges: 0 };
  const absolute = toolEdgePath(project, run.id);
  await withProjectStorageMutation(project, async () => {
    await writeFileAtomicNoFollow(project.rootDir, absolute, serializeExecutedEdges(receipts), { encoding: "utf8", mode: 0o600 });
  });
  return { path: path.relative(project.rootDir, absolute), edges: receipts.length };
}

/* ------------------------------------------------------------- tool traces */

/**
 * @typedef {object} ToolTraceStep
 * @property {number} turn
 * @property {string} tool
 */

/**
 * The call sequence a finished run actually performed: per session, the calls that completed, in the order they completed.
 *
 * Hidden knowledge: this was the "golden trace" of the paired-evaluation corpus — each step with its arguments, a digest of its
 * result and the keys of a structured one, "so a replay is checkable" — and the brief generator that was to build tasks on it
 * (`generate-briefs.mjs`) was deleted on 2026-10-23 without ever having produced one. Nothing read the arguments or the digests
 * in the months they were written. What reads a trace now is the trajectory digest the learning loop's distillation is shown
 * (`trajectoryDigest`, `options.toolTraces`): the order of the tools the work called, which is what a routine is induced from.
 * A call that failed is not a step of the work, and this is the one place that already knows which calls completed, so the
 * digest takes its sequence from here and falls back to the transcript's own calls (every call that was made) when a run has no
 * trace. Only the tool and its turn are kept: the arguments of a call are the person's data and a trace is written for every run.
 *
 * A session with no capability is in it (the ordinary conversation's own session has none): the edge receipts above need a
 * capability to file an edge under, a sequence of tools does not.
 *
 * Turns come from the normalized transcript's own `message.turn`.
 *
 * @param {{runId: string, sessions: readonly any[]}} input
 * @returns {{capability: string | null, sessionId: string, runId: string, steps: ToolTraceStep[]}[]}
 */
export function toolTraces(input) {
  const runId = String(input.runId ?? "");
  if (!runId) return [];
  /** @type {{capability: string | null, sessionId: string, runId: string, steps: ToolTraceStep[]}[]} */
  const traces = [];
  for (const session of input.sessions ?? []) {
    const steps = completedToolCalls(session).map((call) => ({ turn: call.turn, tool: call.tool }));
    if (steps.length) traces.push({ capability: String(session?.capability ?? "") || null, sessionId: String(session?.sessionId ?? ""), runId, steps });
  }
  return traces;
}

/** Where one project's tool traces live, beside its receipts. */
export const TRACE_DIR_NAME = "tool-traces";

/** The schema a trace file carries; a file of another one (the arguments-and-digests shape that was written until 2026-10-25) is not read. */
export const TOOL_TRACE_SCHEMA = "tool-trace/2";

/** @param {{ metaDir: string }} project @param {string} runId @returns {string} */
export function tracePath(project, runId) {
  return path.join(project.metaDir, TRACE_DIR_NAME, `${runId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

/**
 * Write one run's tool traces beside its edge receipts.
 * @param {{project: any, run: {id: string}, sessions: readonly any[]}} input
 * @returns {Promise<{path: string | null, traces: number, steps: number}>}
 */
export async function persistToolTraces({ project, run, sessions }) {
  const traces = toolTraces({ runId: run.id, sessions });
  if (!traces.length) return { path: null, traces: 0, steps: 0 };
  const absolute = tracePath(project, run.id);
  const text = `${JSON.stringify({ schemaVersion: TOOL_TRACE_SCHEMA, runId: run.id, traces })}\n`;
  await withProjectStorageMutation(project, async () => {
    await writeFileAtomicNoFollow(project.rootDir, absolute, text, { encoding: "utf8", mode: 0o600 });
  });
  return {
    path: path.relative(project.rootDir, absolute),
    traces: traces.length,
    steps: traces.reduce((total, trace) => total + trace.steps.length, 0),
  };
}

/**
 * One run's tool traces as they were stored, or an empty list when it has none: a run older than the retention window, a clinical
 * conversation (no trace is kept of one), a store that would not take the write, or a file of another schema are ordinary states,
 * and the digest reads the transcript's own calls instead. A corrupt file is the same state, never an error: the distillation
 * must not be refused for the sequence of its tools.
 * @param {{ rootDir: string, metaDir: string }} project @param {string} runId
 * @returns {Promise<{capability: string | null, sessionId: string, runId: string, steps: ToolTraceStep[]}[]>}
 */
export async function readToolTraces(project, runId) {
  try {
    const text = await readTextFileNoFollow(project.rootDir, tracePath(project, runId), "");
    if (!text) return [];
    const parsed = JSON.parse(text);
    if (parsed?.schemaVersion !== TOOL_TRACE_SCHEMA || parsed.runId !== runId || !Array.isArray(parsed.traces)) return [];
    return parsed.traces.filter((/** @type {any} */ trace) => Array.isArray(trace?.steps)).map((/** @type {any} */ trace) => ({
      capability: typeof trace.capability === "string" && trace.capability ? trace.capability : null,
      sessionId: String(trace.sessionId ?? ""),
      runId,
      steps: trace.steps.filter((/** @type {any} */ step) => typeof step?.tool === "string" && step.tool)
        .map((/** @type {any} */ step) => ({ turn: Number(step.turn) || 0, tool: step.tool })),
    }));
  } catch {
    return [];
  }
}
