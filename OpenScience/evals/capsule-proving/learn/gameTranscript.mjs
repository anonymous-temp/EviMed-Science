/**
 * One C1 text-game episode (a `c1/run_c1.py` trajectory record) as the product stores a finished run: the ledger's record of the run and
 * the transcript file `persistRunTranscript` leaves (`runTranscripts.mjs`: a header line, then one line per message), so the product's own
 * distillation reads it through `readRunTranscript`, `trajectoryDigest` and `buildDistillationInput` unchanged.
 *
 * The mapping, and it is ours, not the product's:
 *  - the episode's opening observation (which states the task) is the person's one request, the first user message of the run's only turn;
 *  - every game command is a tool call of the work, named by its command verb (`go to`, `take`, `open`, `focus on`, ...: the game's own
 *    action grammar, arguments removed) with the command as its input and the game's reply as its output — the game's replies are tool
 *    output, never user messages, so nothing the game says reads as a person's correction (`steeredMessages`);
 *  - the run `succeeded` when the game says the task was won and `failed` otherwise; its scope (`effectiveAgentId`) is the environment.
 * @module gameTranscript
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { TRANSCRIPT_DIR_NAME, TRANSCRIPT_SCHEMA_VERSION, transcriptPath } from "../../../apps/server/src/runTranscripts.mjs";

/** Two-word command verbs of ALFWorld and ScienceWorld; every other command is named by its first word. */
const PHRASES = new Set(["go to", "look around", "look at", "look in", "pick up", "put down", "focus on", "teleport to"]);

/** The tool name a game command is recorded under: its verb, arguments removed. @param {unknown} command @returns {string} */
export function toolNameOf(command) {
  const words = String(command ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "noop";
  const two = words.slice(0, 2).join(" ");
  return PHRASES.has(two) ? two : words[0];
}

/** A stable run id for one episode. @param {{env: string, fold?: string, taskId: string}} record */
export function episodeRunId(record) {
  const digest = createHash("sha256").update(`${record.env}|${record.fold ?? ""}|${record.taskId}`).digest("hex").slice(0, 24);
  return `c1-${record.env}-${record.fold ?? "x"}-${digest}`;
}

/** What the person asked: the opening observation, with the task stated first when the observation does not carry it. @param {any} record */
export function requestText(record) {
  const observation = String(record.initialObservation ?? "").trim();
  const task = String(record.task ?? "").trim();
  return task && !observation.includes(task) ? `Your task is to: ${task}\n\n${observation}` : observation;
}

/**
 * The run record and transcript of one episode.
 * @param {any} record a run_c1 trajectory record @param {{finishedAt: string}} clock
 * @returns {{ run: any, transcript: { header: any, messages: any[] } }}
 */
export function episodeAsRun(record, { finishedAt }) {
  const runId = episodeRunId(record);
  const sessionId = `s-${runId}`;
  const requestId = `req-${runId}`;
  const question = requestText(record);
  /** @type {any[]} */
  const messages = [{ sessionId, seq: 0, turnStartSeq: 0, sourceRequestId: requestId, role: "user", source: "user", parts: [{ type: "text", text: question }] }];
  let seq = 1;
  for (const step of Array.isArray(record.steps) ? record.steps : []) {
    /** @type {any[]} */
    const parts = [];
    const text = String(step?.reply?.text ?? "").trim();
    if (text) parts.push({ type: "text", text });
    if (typeof step?.action === "string" && step.action) {
      parts.push({ type: "tool", tool: toolNameOf(step.action), callID: `call-${runId}-${step.step}`, input: { command: step.action },
        output: typeof step.observation === "string" ? step.observation : "" });
    }
    if (parts.length) messages.push({ sessionId, seq: seq++, turnStartSeq: 0, role: "assistant", source: "system", parts });
  }
  const header = { schemaVersion: TRANSCRIPT_SCHEMA_VERSION, runId, capturedAt: finishedAt, completeness: "complete",
    sessions: [{ sessionId, parentSessionId: null, seedEndSeq: -1 }], missing: [] };
  const run = {
    id: runId, sessionId, kernelRequestIds: [requestId], question,
    status: record.success === true ? "succeeded" : "failed",
    effectiveAgentId: String(record.env),
    startedAt: finishedAt, finishedAt,
    transcript: { completeness: "complete", messages: messages.length },
    c1: { taskId: record.taskId, env: record.env, fold: record.fold ?? null, success: record.success === true, score: Number(record.score) || 0,
      steps: Array.isArray(record.steps) ? record.steps.length : 0 },
  };
  return { run, transcript: { header, messages } };
}

/** Write the transcript where `readRunTranscript(project, runId)` reads it. @param {any} project @param {{header: any, messages: any[]}} transcript */
export async function storeTranscript(project, transcript) {
  await mkdir(path.join(project.metaDir, TRANSCRIPT_DIR_NAME), { recursive: true });
  const lines = [transcript.header, ...transcript.messages].map((line) => JSON.stringify(line)).join("\n");
  await writeFile(transcriptPath(project, transcript.header.runId), `${lines}\n`);
}
