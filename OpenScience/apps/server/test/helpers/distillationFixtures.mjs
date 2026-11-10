// Fixed lessons the distillation is pinned on: with every lab switch off (camp, two-stage), the frozen input and the dispatch question of each
// must be byte for byte what they were before the switches existed. The digests in `methodDistillationCamp.test.mjs` were computed from the
// code as it stood at the integration branch's head on 2026-11-10 (before F3), with these exact fixtures.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { METHOD_SKILL_SCHEMA } from "@evimed/domain";

import { TRANSCRIPT_DIR_NAME, transcriptPath } from "../../src/runTranscripts.mjs";

const ROOT = "ses_root";

/** @param {number} seq @param {string} text @param {Record<string, any>} [extra] */
const user = (seq, text, extra = {}) => ({ sessionId: ROOT, role: "user", source: "user", seq, turn: 1, turnStartSeq: 1, sourceRequestId: "req_1", parts: [{ type: "text", text }], ...extra });
/** @param {number} seq @param {string} text */
const said = (seq, text) => ({ sessionId: ROOT, role: "assistant", source: "user", seq, turn: 1, turnStartSeq: 1, parts: [{ type: "text", text }] });
/** @param {number} seq @param {string} tool @param {string} output */
const call = (seq, tool, output) => ({ sessionId: ROOT, role: "assistant", source: "user", seq, turn: 1, turnStartSeq: 1,
  parts: [{ type: "tool", tool, callId: `c${seq}`, status: "completed", input: { path: `notes-${seq}.md` }, output }] });

/** @param {string} runId @param {any[]} messages */
const transcriptOf = (runId, messages) => ({ header: { schemaVersion: 1, runId, capturedAt: "2026-11-01T00:00:00.000Z", completeness: "complete",
  sessions: [{ sessionId: ROOT, parentSessionId: null, seedEndSeq: -1 }], missing: [] }, messages });

/** @param {string} name @param {string} digestHex @param {string} role */
function method(name, digestHex, role) {
  return {
    id: `method:learned:${name}`, revision: 2,
    payload: {
      recordType: "learned-method", status: "approved", contentDigest: `sha256:${digestHex.repeat(64 / digestHex.length)}`,
      frontmatter: { name, description: `Does ${name} the way this person does it.`, whenToUse: `When ${name} comes up.`,
        metadata: { role, applies_when: `${name} is asked for.`, not_when: "Anything else.", derived_from: "run:r0", evimed_schema: METHOD_SKILL_SCHEMA } },
      body: "## Purpose\nDo it.\n\n## Workflow\n1. Do it in order.",
      scope: { applicability: `${name} work.`, counterexamples: ["Other work."], digest: `sha256:${digestHex.repeat(64 / digestHex.length)}` },
      provenance: { origin: "inferred", runId: "r0", scope: "conversation" },
      dependencies: [],
    },
  };
}

/** The fixed lessons: a routine with two peers, a correction steered into the run, an adoption on the next turn, and an edit. */
export function identityFixtures() {
  const routineMessages = [user(2, "把本周随访数据整理成周报，按科室分三节"), call(3, "read", "随访数据 120 行"), said(4, "周报已写好，三节。"), call(5, "write", "ok")];
  const peerMessages = [user(2, "整理上周随访周报，按科室分节"), call(3, "read", "随访数据 98 行"), said(4, "已完成周报。")];
  const correctionMessages = [user(2, "写一段研究背景，介绍二甲双胍的研究现状"), said(3, "初稿如下……"), user(4, "不要写剂量，只写研究设计", { sourceRequestId: "req_1" }),
    call(5, "write", "background.md"), said(6, "改好了，只写了研究设计。")];
  const adoptedMessages = [user(2, "按我们组的格式写会议纪要"), call(3, "write", "minutes.md"), said(4, "纪要已写好：议题、结论、待办三栏。")];
  const related = [method("weekly-report-layout", "a1", "functional"), method("read-sheet-header-first", "b2", "atomic"), method("research-background-plan", "c3", "abstract")];
  return [
    { label: "routine", trigger: "routine", run: { id: "run_routine", sessionId: ROOT, kernelRequestIds: ["req_1"], status: "succeeded", effectiveAgentId: "open-domain-answer" },
      transcript: transcriptOf("run_routine", routineMessages), relatedMethods: related,
      peers: [{ runId: "run_peer_1", messages: peerMessages }, { runId: "run_peer_2", messages: peerMessages.map((message) => ({ ...message })) }], feedback: [] },
    { label: "correction", trigger: "correction", run: { id: "run_correction", sessionId: ROOT, kernelRequestIds: ["req_1"], status: "succeeded", corrections: 1 },
      transcript: transcriptOf("run_correction", correctionMessages), relatedMethods: related.slice(2), peers: [], feedback: [] },
    { label: "adopted", trigger: "adopted", run: { id: "run_adopted", sessionId: ROOT, kernelRequestIds: ["req_1"], status: "succeeded" },
      transcript: transcriptOf("run_adopted", adoptedMessages), relatedMethods: related.slice(0, 1), peers: [],
      feedback: [{ id: "fe_adopt", trigger: "learning-evidence", detail: { evidence: "follow-up", verdict: "adopt", rule: "会议纪要都按这个格式", quote: "以后纪要都这样写" } }] },
    { label: "edit", trigger: "edit_diff", run: { id: "run_edit", sessionId: ROOT, kernelRequestIds: ["req_1"], status: "succeeded" },
      transcript: transcriptOf("run_edit", routineMessages), relatedMethods: [], peers: [], feedback: [] },
  ];
}

/** The `buildDistillationInput` arguments of a fixture. @param {any} fixture */
export function inputArguments(fixture) {
  return {
    run: fixture.run, trigger: fixture.trigger, transcript: fixture.transcript, feedback: fixture.feedback, relatedMethods: fixture.relatedMethods,
    peerRuns: fixture.peers.map((/** @type {any} */ peer) => ({ runId: peer.runId, run: { id: peer.runId, sessionId: ROOT, kernelRequestIds: ["req_1"], status: "succeeded" },
      transcript: transcriptOf(peer.runId, peer.messages) })),
  };
}

/** A project directory holding a fixture's transcripts, where `readRunTranscript` reads them. @param {string} dir @param {any} fixture */
export async function projectFor(dir, fixture) {
  const project = { id: "p_fixture", userId: "u_fixture", rootDir: dir, metaDir: path.join(dir, ".openscience"), workspaceDir: path.join(dir, "workspace") };
  await mkdir(path.join(project.metaDir, TRANSCRIPT_DIR_NAME), { recursive: true });
  const write = async (/** @type {any} */ transcript) => writeFile(transcriptPath(project, transcript.header.runId),
    `${[transcript.header, ...transcript.messages].map((line) => JSON.stringify(line)).join("\n")}\n`);
  await write(fixture.transcript);
  for (const peer of fixture.peers) await write(transcriptOf(peer.runId, peer.messages));
  return project;
}

/**
 * What one `execute` of a fixture dispatches — the question and the frozen input — with a dispatcher that records the request and a result
 * reader that answers `failed`, so nothing is written. `Runs` is the `MethodDistillationRuns` class under test; `options` its switches.
 * @param {any} Runs @param {string} dir @param {any} fixture @param {Record<string, any>} [options]
 */
export async function dispatchedFor(Runs, dir, fixture, options = {}) {
  const project = await projectFor(dir, fixture);
  /** @type {any[]} */
  const requests = [];
  const library = fixture.relatedMethods;
  const runs = new Runs({
    learning: { async listMethods() { return { items: library, nextCursor: null }; }, async getMethod() { return null; } },
    dispatch: async (/** @type {any} */ request) => { requests.push(request); return { runId: "lr_1", sessionId: "ls_1", dispatchId: request.dispatchId }; },
    readResult: async () => ({ status: "failed" }),
    resolveRun: async (/** @type {any} */ _project, /** @type {string} */ runId) => ({ id: runId, sessionId: ROOT, kernelRequestIds: ["req_1"], status: "succeeded" }),
    ...options,
  });
  const job = { id: `job_${fixture.label}`, userId: project.userId, projectId: project.id,
    payload: { runId: fixture.run.id, trigger: fixture.trigger, ...(fixture.peers.length ? { peers: fixture.peers.map((/** @type {any} */ peer) => ({ runId: peer.runId, projectId: null })) } : {}),
      ...(fixture.trigger === "adopted" ? { dispatchKey: "fe_adopt", feedbackEventIds: ["fe_adopt"], feedback: fixture.feedback } : {}) } };
  await runs.execute({ job, project, run: fixture.run, feedback: fixture.feedback }).catch((/** @type {any} */ error) => {
    if (error?.code !== "method_distillation_run_failed") throw error;
  });
  return requests;
}
