// What a distillation is shown of a run, and what it may keep of what it was shown (2026-10-23).
//
// The input used to be `slice(-limit)` of the stored transcript — for a delegating run the last child's submit, repair and summary — and the
// seventy methods learnt from it were all about the platform's own bookkeeping. These are the cases the rectification names: the first request and
// the intervention survive however long the run was, the platform's choreography is gone before any model sees the run, a routine carries digests,
// the related methods are the nearest by meaning, and a method rests only on quotations that are in what the model was shown.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { METHOD_SKILL_SCHEMA, SOCKET_TOOL_NAME_LIST } from "@evimed/domain";

import { LEARNING_PROJECT_ID } from "../src/internalProjects.mjs";
import {
  MethodDistillationRuns, buildDistillationInput, evidenceCorpus, lessonQueryText, reactionsOf, unionEvidence, verifiedEvidence,
} from "../src/methodDistillationRuns.mjs";
import { TRANSCRIPT_DIR_NAME, transcriptPath } from "../src/runTranscripts.mjs";

const ROOT = "ses_root";
const CHILD = "ses_child";

/** @param {number} seq @param {string} text @param {Record<string, any>} [extra] */
const user = (seq, text, extra = {}) => ({ sessionId: ROOT, role: "user", source: "user", seq, turn: 1, turnStartSeq: 1, sourceRequestId: "req_1", parts: [{ type: "text", text }], ...extra });
/** @param {number} seq @param {string} text @param {string} [sessionId] */
const said = (seq, text, sessionId = ROOT) => ({ sessionId, role: "assistant", source: "user", seq, turn: 1, turnStartSeq: 1, parts: [{ type: "text", text }] });
/** @param {number} seq @param {string} tool @param {string} [sessionId] */
const call = (seq, tool, sessionId = ROOT) => ({ sessionId, role: "assistant", source: "user", seq, turn: 1, turnStartSeq: 1,
  parts: [{ type: "tool", tool, callId: `c${seq}`, status: "completed", input: {}, output: "ok" }] });

/** A delegated run's stored shape: the root's lines, then the child's, the work in the middle, the platform's submit and repair at the end. */
function delegatedRun() {
  const messages = [
    user(2, "帮我把本周随访数据整理成周报，按科室分三节，每节三行"),
    call(3, "evimed_plan"),
    call(4, "evimed_delegate"),
    said(5, "已委派。"),
    user(6, "每节不要超过三行，数字都带单位", { sourceRequestId: "req_2" }),
    call(7, "evimed_await"),
    said(8, "完成。"),
  ];
  // The child's side: a long stretch of work, then the platform's own checks.
  for (let seq = 10; seq < 130; seq += 1) messages.push(seq % 3 ? call(seq, "read", CHILD) : said(seq, `整理第 ${seq} 条记录`, CHILD));
  messages.push(call(130, "evimed_submit_deliverable", CHILD), call(131, "evimed_package_check", CHILD), call(132, "evimed_revise_deliverable", CHILD),
    call(133, "evimed_render_report", CHILD), call(134, "present", CHILD), said(135, "已提交，锚点与回执已更新。", CHILD));
  return {
    transcript: { header: { completeness: "complete", sessions: [{ sessionId: ROOT, parentSessionId: null }, { sessionId: CHILD, parentSessionId: ROOT }] }, messages },
    run: { id: "run_1", sessionId: ROOT, kernelRequestIds: ["req_1"], status: "succeeded", effectiveAgentId: "clinical-evidence-synthesis", artifacts: ["report/weekly.md"] },
  };
}

test("the first request and the intervention survive a long delegated run, and no choreography tool name reaches the model", () => {
  const { transcript, run } = delegatedRun();
  const input = buildDistillationInput({ run, trigger: "correction", transcript });
  assert.equal(input.trajectory.requests[0].text, "帮我把本周随访数据整理成周报，按科室分三节，每节三行", "the opening request, which a tail window loses first");
  assert.deepEqual(input.trajectory.interventions.map((entry) => [entry.kind, entry.seq, entry.text]), [["steer", 6, "每节不要超过三行，数字都带单位"]]);
  assert.deepEqual(input.trajectory.tools, ["read"], "the work's tools, in order, without the platform's");
  assert.deepEqual(input.trajectory.outcome, { status: "succeeded", repaired: false });
  assert.deepEqual(input.corrections.map((entry) => entry.text), ["每节不要超过三行，数字都带单位"]);

  // An excerpt anchored on the steer, twelve messages either side, in the root session — not the child's tail.
  assert.equal(input.transcriptExcerpts.length, 1);
  const [excerpt] = input.transcriptExcerpts;
  assert.equal(excerpt.sessionId, ROOT);
  assert.deepEqual(excerpt.anchor, { kind: "intervention", seq: 6 });
  assert.ok(excerpt.seqRange[0] <= 6 && excerpt.seqRange[1] >= 6 && excerpt.seqRange[1] <= 18);
  assert.ok(excerpt.messages.every((message) => message.sessionId === ROOT));

  const text = JSON.stringify(input);
  for (const name of [...SOCKET_TOOL_NAME_LIST, "present"]) assert.ok(!text.includes(`"${name}"`), `${name} is not in what the model reads`);
  assert.ok(!text.includes("锚点与回执"), "the closing summary of the platform's submit is not in it either");
});

test("a trigger that points at an edit or a repair still reads a tail, without the choreography in it", () => {
  const { transcript, run } = delegatedRun();
  const input = buildDistillationInput({ run, trigger: "repair_accepted", transcript });
  assert.ok(input.transcriptExcerpts.length >= 1);
  assert.ok(input.transcriptExcerpts.every((excerpt) => excerpt.anchor.kind === "tail"));
  const text = JSON.stringify(input.transcriptExcerpts);
  for (const name of SOCKET_TOOL_NAME_LIST) assert.ok(!text.includes(`"${name}"`), name);
});

test("a follow-up and a corrected result are interventions with no place in the run, read through the closing window", () => {
  const { transcript, run } = delegatedRun();
  const feedback = [
    { id: "fe_1", trigger: "learning-evidence", detail: { evidence: "follow-up", verdict: "correction", rule: "周报每节只写三行", quote: "不对，每节只要三行" } },
    { id: "fe_2", trigger: "result-corrected", detail: { instruction: "把第二节删掉" } },
  ];
  assert.deepEqual(reactionsOf(feedback).map((entry) => [entry.kind, entry.text, entry.rule ?? null]), [
    ["follow-up", "不对，每节只要三行", "周报每节只写三行"], ["result-corrected", "把第二节删掉", null],
  ]);
  const input = buildDistillationInput({ run: { ...run, kernelRequestIds: ["req_1", "req_2"] }, trigger: "correction", transcript, feedback });
  assert.deepEqual(input.trajectory.interventions.map((entry) => [entry.kind, entry.seq]), [["steer", 6], ["follow-up", null], ["result-corrected", null]]);
  assert.deepEqual(input.transcriptExcerpts.map((excerpt) => excerpt.anchor.kind), ["intervention", "closing"]);
  assert.equal(input.signal, "researcher");
});

test("a routine carries each member's digest and no raw lines, and a lesson with nothing to anchor on reads none", () => {
  const { transcript, run } = delegatedRun();
  const peer = { runId: "run_0", transcript: { ...transcript, header: { completeness: "complete" } }, run: { ...run, id: "run_0", kernelRequestIds: ["req_1"] },
    shapes: { "report/weekly.md": { format: "md", labels: ["Summary", "Findings"] } } };
  const input = buildDistillationInput({ run, trigger: "routine", transcript, peerRuns: [peer] });
  assert.deepEqual(input.transcriptExcerpts, []);
  assert.equal(input.peerRuns[0].trajectory.requests[0].text, "帮我把本周随访数据整理成周报，按科室分三节，每节三行");
  assert.deepEqual(input.peerRuns[0].trajectory.artifacts[0].shape?.labels, ["summary", "findings"]);
  assert.deepEqual(input.peerRuns[0].trajectory.tools, ["read"]);
  assert.equal(input.scope, "clinical-evidence-synthesis");
  assert.equal(buildDistillationInput({ run: { ...run, effectiveAgentId: "open-domain-answer" }, trigger: "routine", transcript }).scope, "conversation");
});

test("a stored quotation must be in what the distillation was shown, from the run it names, between 8 and 600 characters, at most twenty, once each", () => {
  const { transcript, run } = delegatedRun();
  const input = buildDistillationInput({ run, trigger: "correction", transcript });
  const corpus = evidenceCorpus(input);
  const entry = (quote, runId = "run_1", seqRange = [6, 6]) => ({ runId, seqRange, quote });
  const { kept, dropped } = verifiedEvidence([
    entry("每节不要超过三行，数字都带单位"),
    entry("每节不要超过   三行，数字都带单位"),
    entry("每节只要两行，数字不用单位"),
    entry("帮我把本周随访数据整理成周报"),
    entry("每节不要超过三行", "run_other"),
    entry("三行"),
    entry("每节不要超过三行，数字都带单位", "run_1", [6]),
    entry("x".repeat(601)),
  ], corpus);
  assert.deepEqual(kept.map((item) => item.quote), ["每节不要超过三行，数字都带单位", "帮我把本周随访数据整理成周报"]);
  assert.equal(dropped, 6, "a paraphrase, another run's text, a quotation too short or long and one with no span are dropped, never repaired");
  const many = Array.from({ length: 30 }, (_, index) => `第 ${index} 次整理周报时的做法说明`);
  const big = new Map([["run_1", many.join("\n")]]);
  assert.equal(verifiedEvidence(many.map((quote) => entry(quote)), big).kept.length, 20);
  assert.deepEqual(unionEvidence([{ runId: "a", seqRange: [1, 2], quote: "第一条引用的内容" }], [{ runId: "b", seqRange: [3, 4], quote: "第一条引用的内容" }, "第二条引用的内容"]).length, 2);
  assert.equal(unionEvidence(many.map((quote) => ({ quote })), [{ quote: "最新的一条引用内容" }]).at(-1).quote, "最新的一条引用内容", "past twenty the oldest give way");
});

// ---------------------------------------------------------------------------------------------------- applyCandidate

const BODY = ["## Purpose", "P.", "", "## When to Use", "W.", "", "## Inputs", "I.", "", "## Workflow", "1. Do.", "", "## Verification", "- Checked.", "",
  "## Constraints", "- Never.", "", "## Output", "O."].join("\n");
const SKILL = ["---", 'name: "weekly-report-three-lines"', 'description: "Writes the weekly report with three lines a section when the researcher asks for a weekly report."',
  'whenToUse: "When a weekly report is asked for."', "metadata:", '  role: "functional"', '  applies_when: "A weekly report is asked for."', '  not_when: "Another report."',
  '  derived_from: "run:run_1"', `  evimed_schema: "${METHOD_SKILL_SCHEMA}"`, "---", "", BODY, ""].join("\n");

/** A learning service holding methods by id, recording what it is asked to write. @param {Record<string, any>} [held] */
function ledger(held = {}) {
  /** @type {any[]} */ const created = [];
  /** @type {any[]} */ const amended = [];
  return {
    created, amended,
    async createCandidate(userId, input) { created.push({ userId, ...input }); return { id: "method:learned:weekly-report-three-lines", revision: 1 }; },
    async amendMethod(userId, methodId, input) { amended.push({ userId, methodId, ...input }); return { id: methodId, revision: 5 }; },
    async getMethod(_userId, methodId) {
      if (!held[methodId]) throw Object.assign(new Error("not found"), { code: "method_not_found" });
      return { id: methodId, revision: 3, ...held[methodId] };
    },
  };
}
const distillationOver = (learning) => new MethodDistillationRuns({
  learning, dispatch: async () => { throw new Error("no dispatch"); }, readResult: async () => { throw new Error("no result"); },
  jobs: { enqueue: async () => ({ id: "job" }) },
});
const job = { id: "job_9", userId: "u1", projectId: "p1", payload: { feedbackEventIds: ["fe_1"], trigger: "correction" } };

test("a created method stores the quotations that are in the input, the scope it was learnt in, and nothing a model only claimed", async () => {
  const { transcript, run } = delegatedRun();
  const input = buildDistillationInput({ run, trigger: "correction", transcript });
  const learning = ledger();
  const counted = [];
  const distillation = new MethodDistillationRuns({
    learning, dispatch: async () => { throw new Error("no dispatch"); }, readResult: async () => { throw new Error("no result"); }, jobs: { enqueue: async () => ({ id: "job" }) },
    onEvidence: (counts) => counted.push(counts),
  });
  await distillation.applyCandidate(job, run, { skill: SKILL, candidate: { operation: "create", evidence: [
    { runId: "run_1", seqRange: [6, 6], quote: "每节不要超过三行，数字都带单位" },
    { runId: "run_1", seqRange: [6, 6], quote: "用户说过以后都用英文写" },
  ] } }, { signal: "researcher", evidence: evidenceCorpus(input) });
  assert.deepEqual(learning.created[0].provenance.evidence, [{ runId: "run_1", seqRange: [6, 6], quote: "每节不要超过三行，数字都带单位" }]);
  assert.equal(learning.created[0].provenance.scope, "clinical-evidence-synthesis");
  assert.deepEqual(counted, [{ kept: 1, dropped: 1 }]);

  // Applied with no corpus (nothing says what the model was shown), none are stored.
  const bare = ledger();
  await distillationOver(bare).applyCandidate(job, run, { skill: SKILL, candidate: { operation: "create", evidence: [{ runId: "run_1", seqRange: [6, 6], quote: "每节不要超过三行，数字都带单位" }] } });
  assert.equal(bare.created[0].provenance.evidence, undefined);
  // The ordinary conversation's scope.
  const talk = ledger();
  await distillationOver(talk).applyCandidate(job, { id: "run_2", effectiveAgentId: "open-domain-answer" }, { skill: SKILL, candidate: { operation: "create" } }, { signal: "run" });
  assert.equal(talk.created[0].provenance.scope, "conversation");
});

test("an amendment keeps the quotations the method stood on and its scope; a lesson from another scope widens it to none, and never narrows one that had none", async () => {
  const id = "method:learned:weekly-report-three-lines";
  const corpus = new Map([["run_1", "新的一条引用 每节只要三行 在这里"]]);
  const quote = "新的一条引用 每节只要三行 在这里";
  const held = (provenance) => ({ [id]: { payload: { dependencies: [], contentDigest: "sha256:old", status: "approved", provenance } } });
  const lesson = { skill: SKILL, candidate: { operation: "amend", targetMethodId: id, evidence: [{ runId: "run_1", seqRange: [1, 2], quote }] } };

  const same = ledger(held({ scope: "clinical-evidence-synthesis", evidence: [{ runId: "run_0", seqRange: [4, 5], quote: "先前的一条引用内容" }] }));
  await distillationOver(same).applyCandidate(job, { id: "run_1", effectiveAgentId: "clinical-evidence-synthesis" }, lesson, { signal: "researcher", evidence: corpus });
  assert.deepEqual(same.amended[0].provenance.evidence.map((entry) => entry.quote), ["先前的一条引用内容", quote]);
  assert.equal(same.amended[0].provenance.scope, "clinical-evidence-synthesis");

  const wider = ledger(held({ scope: "clinical-evidence-synthesis" }));
  await distillationOver(wider).applyCandidate(job, { id: "run_1", effectiveAgentId: "open-domain-answer" }, lesson, { signal: "researcher", evidence: corpus });
  assert.equal(wider.amended[0].provenance.scope, undefined, "evidence from two scopes is evidence for both");

  const unscoped = ledger(held({}));
  await distillationOver(unscoped).applyCandidate(job, { id: "run_1", effectiveAgentId: "clinical-evidence-synthesis" }, lesson, { signal: "researcher", evidence: corpus });
  assert.equal(unscoped.amended[0].provenance.scope, undefined, "a method learnt before scopes existed is not narrowed by one lesson");
});

test("a merge folds the methods it names through the builder's pending-retirement path, read from the ledger and never from the candidate's word", async () => {
  const target = "method:learned:weekly-report-three-lines";
  const folded = "method:learned:weekly-report-short";
  const retired = "method:learned:weekly-report-old";
  const learning = ledger({
    [target]: { payload: { dependencies: [], contentDigest: "sha256:t", status: "approved", provenance: { scope: "conversation", evidence: [{ runId: "r0", seqRange: [1, 2], quote: "目标方法的引用内容" }] } } },
    [folded]: { payload: { dependencies: [], contentDigest: "sha256:f", status: "approved", provenance: { scope: "conversation", evidence: [{ runId: "r0", seqRange: [3, 4], quote: "被并入方法的引用内容" }] } } },
    [retired]: { payload: { dependencies: [], contentDigest: "sha256:r", status: "retired", provenance: {} } },
  });
  const outcome = await distillationOver(learning).applyCandidate(job, { id: "run_1", effectiveAgentId: "open-domain-answer" }, {
    skill: SKILL, candidate: { operation: "merge", targetMethodId: target, mergedMethodIds: [target, folded, retired, "method:learned:made-up"] },
  }, { signal: "researcher", evidence: new Map() });
  assert.deepEqual([outcome.operation, outcome.methodId], ["merge", target]);
  const { provenance } = learning.amended[0];
  assert.deepEqual(provenance.pendingRetirements, [{ methodId: folded, baseDigest: "sha256:f", assignment: "distill:run_1" }], "a retired method and an invented one are not folded");
  assert.deepEqual(provenance.mergedFrom, [{ methodId: folded, digest: "sha256:f" }]);
  assert.equal(provenance.consolidatedBy, "consolidate:distill:job_9", "the builder's pass retires the folded one once the merged method has cleared the harm test");
  assert.equal(provenance.scope, "conversation");
  assert.deepEqual(provenance.evidence.map((entry) => entry.quote), ["目标方法的引用内容", "被并入方法的引用内容"]);
  assert.equal(provenance.runId, "run_1", "still a method a run taught, so it is never read as an unproven merge");
});

// ---------------------------------------------------------------------------------------------------- execute

/** A project directory holding one run's stored transcript and a file it left. @param {string} root */
async function projectWith(root) {
  const rootDir = path.join(root, "p");
  const project = { id: "p", userId: "u1", rootDir, metaDir: path.join(rootDir, ".openscience"), workspaceDir: path.join(rootDir, "workspace") };
  await mkdir(path.join(project.metaDir, TRANSCRIPT_DIR_NAME), { recursive: true });
  await mkdir(path.join(project.workspaceDir, "report"), { recursive: true });
  await writeFile(path.join(project.workspaceDir, "report/weekly.md"), "# 周报\n## 总览\n## 下周计划\n");
  const { transcript, run } = delegatedRun();
  const header = { schemaVersion: 1, runId: run.id, capturedAt: "2026-10-23T00:00:00.000Z", completeness: "complete", sessions: transcript.header.sessions, missing: [] };
  await writeFile(transcriptPath(project, run.id), `${[JSON.stringify(header), ...transcript.messages.map((message) => JSON.stringify(message))].join("\n")}\n`);
  return { project, run };
}

const method = (id, name, description) => ({ id, payload: { status: "approved", contentDigest: `sha256:${name}`, frontmatter: { name, description, whenToUse: description }, body: `body of ${name}` } });

test("the related methods are the nearest to what the lesson is about, the files are read for their shape, and a similarity that fails leaves the most recent", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "evimed-distill-input-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { project, run } = await projectWith(root);
  const library = Array.from({ length: 12 }, (_, index) => method(`method:learned:m${index}`, `m${index}`, `method number ${index}`));
  /** @type {any[]} */ const dispatched = [];
  /** @type {string[]} */ const queries = [];
  const similarity = { nearest: async (query, methods, options) => { queries.push(query); return [methods[9], methods[3], methods[7]].map((found, score) => ({ method: found, score: 1 - score / 10 })).slice(0, options.limit); } };
  const make = (extra) => new MethodDistillationRuns({
    learning: { async listMethods() { return { items: library }; } },
    dispatch: async (request) => { dispatched.push(request); return { runId: "lr_1", sessionId: "ls_1", dispatchId: request.dispatchId }; },
    readResult: async () => ({ status: "running" }),
    ...extra,
  });
  const lesson = { userId: "u1", projectId: "p", payload: { runId: run.id, trigger: "correction", steeredCorrections: 1 } };

  await make({ similarity }).execute({ project, run, job: lesson });
  assert.deepEqual(dispatched[0].input.relatedMethods.map((entry) => entry.id), ["method:learned:m9", "method:learned:m3", "method:learned:m7"]);
  assert.ok(queries[0].includes("每节不要超过三行，数字都带单位") && queries[0].includes("帮我把本周随访数据整理成周报"), "what the person said and first asked");
  assert.ok(queries[0].includes("总览") && queries[0].includes("md"), "and the shape of what was left");
  assert.deepEqual(dispatched[0].input.trajectory.artifacts[0].shape?.labels, ["周报", "总览", "下周计划"], "the digest says what kind of thing the run left");
  assert.equal(dispatched[0].input.extractorVersion, "8");

  await make({ similarity: { nearest: async () => { throw new Error("embedder down"); } } }).execute({ project, run, job: lesson });
  assert.deepEqual(dispatched[1].input.relatedMethods.map((entry) => entry.id), library.slice(0, 8).map((entry) => entry.id), "the most recently written, as before");
  await make({}).execute({ project, run, job: lesson });
  assert.equal(dispatched[2].input.relatedMethods.length, 8);
  assert.equal(lessonQueryText({ run: { id: "x" }, trigger: "correction", transcript: null, shapes: null }), "", "nothing to be near, nothing to rank by");
});

test("a routine's peer is digested from its own ledger record, and the lesson's own project is never asked for", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "evimed-distill-peers-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { project, run } = await projectWith(root);
  const peerRun = { ...run, id: "run_0", outputFiles: ["report/weekly.md"], artifacts: [] };
  await writeFile(transcriptPath(project, "run_0"), await (await import("node:fs/promises")).readFile(transcriptPath(project, run.id)));
  /** @type {any[]} */ const dispatched = [];
  const asked = [];
  const distillation = new MethodDistillationRuns({
    learning: { async listMethods() { return { items: [] }; } },
    dispatch: async (request) => { dispatched.push(request); return { runId: "lr_1", sessionId: "ls_1", dispatchId: request.dispatchId }; },
    readResult: async () => ({ status: "running" }),
    resolveRun: async (resolved, runId) => { asked.push([resolved.id, runId]); return runId === "run_0" ? peerRun : null; },
  });
  await distillation.execute({ project, run, job: { userId: "u1", projectId: "p", payload: { runId: run.id, trigger: "routine", scope: "clinical-evidence-synthesis",
    peers: [{ runId: "run_0", projectId: "p" }, { runId: "run_missing", projectId: LEARNING_PROJECT_ID }] } } });
  assert.deepEqual(asked, [["p", "run_0"]], "an internal project is never resolved, whatever the payload says");
  const [first, second] = dispatched[0].input.peerRuns;
  assert.equal(first.trajectory.requests[0].text, "帮我把本周随访数据整理成周报，按科室分三节，每节三行");
  assert.deepEqual(first.trajectory.artifacts.map((artifact) => [artifact.path, artifact.shape?.labels]), [["report/weekly.md", ["周报", "总览", "下周计划"]]]);
  assert.equal(second.trajectory, null);
});
