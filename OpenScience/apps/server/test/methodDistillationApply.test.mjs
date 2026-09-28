// What a distillation run is allowed to write about itself.
//
// This file exists because `applyCandidate` had no test at all, and the thing
// it turned out to be doing was letting the run's own model output choose
// `origin: "explicit"` — the one value that exempts a method from the paired
// evaluation and mounts it into every later run of the project. Every other
// part of the design was arranged so that generation cannot approve itself, and
// the bypass was one word in a JSON file the model wrote.
//
// So the load-bearing test here is the first one, and it is deliberately
// written against the hostile input rather than the happy path: the happy path
// was green the whole time the hole was open.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { METHOD_SKILL_SCHEMA, parseSkillFrontmatter, validateMethodSkill } from "@evimed/domain";

import { LEARNING_PROJECT_ID } from "../src/internalProjects.mjs";
import { decodeLearningOutput } from "../src/learningRuntime.mjs";
import { MethodDistillationRuns, buildDistillationInput, lessonSignal, steeredCorrections } from "../src/methodDistillationRuns.mjs";
import { TRANSCRIPT_DIR_NAME, transcriptPath } from "../src/runTranscripts.mjs";

const BODY = [
  "## Purpose", "Do a thing.", "",
  "## When to Use", "When the thing is needed.", "",
  "## Inputs", "A frozen input.", "",
  "## Workflow", "1. Do it.", "",
  "## Verification", "- It was done.", "",
  "## Constraints", "- Never do the other thing.", "",
  "## Output", "The thing.",
].join("\n");

const SKILL = [
  "---",
  'name: "do-the-thing"',
  'description: "Does the thing when the thing is needed, using only the frozen input it is given."',
  'whenToUse: "When the thing is needed."',
  "metadata:",
  '  role: "functional"',
  '  applies_when: "The thing is needed."',
  '  not_when: "The other thing is needed."',
  '  derived_from: "run:run_1"',
  `  evimed_schema: "${METHOD_SKILL_SCHEMA}"`,
  "---",
  "",
  BODY,
  "",
].join("\n");

/** A learning service that records what it was asked to write.
 *  @param {string[]} [existing] method ids the library already holds */
function fakeLearning(existing = []) {
  /** @type {any[]} */
  const created = [];
  /** @type {any[]} */
  const amended = [];
  /** @type {any[]} */
  const handbook = [];
  const held = new Set(existing);
  return {
    created, amended, handbook,
    async createCandidate(userId, input) { created.push({ userId, ...input }); return { id: "method:learned:do-the-thing", revision: 1 }; },
    async amendMethod(userId, methodId, input) { amended.push({ userId, methodId, ...input }); return { id: methodId, revision: 4 }; },
    async recordHandbookCandidate(userId, input) { handbook.push({ userId, ...input }); return { id: "method:handbook:do-the-thing", revision: 1 }; },
    async getMethod(_userId, methodId) {
      if (!held.has(methodId)) throw Object.assign(new Error("not found"), { code: "method_not_found" });
      return { id: methodId, revision: 3, payload: { dependencies: [] } };
    },
  };
}

/** @param {any} [learning] */
function runs(learning = fakeLearning()) {
  /** @type {any[]} */
  const enqueued = [];
  const distillation = new MethodDistillationRuns({
    learning,
    jobs: { async enqueue(userId, kind, payload, opts) { enqueued.push({ userId, kind, payload, opts }); return { id: "job_2" }; } },
    // `applyCandidate` never reaches either of these; they are required at
    // construction because the class as a whole dispatches a bounded run.
    dispatch: async () => { throw new Error("applyCandidate must not dispatch a run"); },
    readResult: async () => { throw new Error("applyCandidate must not read a run result"); },
  });
  return { distillation, learning, enqueued };
}

const job = { userId: "u1", projectId: "p1", payload: { feedbackEventIds: ["fe_1"] } };
const run = { id: "run_1" };

test("a distillation run cannot mint an explicit method, however it labels its own output", async () => {
  const { distillation, learning } = runs();
  await distillation.applyCandidate(job, run, {
    candidate: { operation: "create", origin: "explicit" },
    skill: SKILL,
  });
  assert.equal(learning.created.length, 1);
  assert.equal(learning.created[0].provenance.origin, "inferred",
    "an explicit origin skips the paired evaluation; only a person may claim one");
  // The external part of the trigger is still recorded — it is evidence, not an
  // exemption.
  assert.deepEqual(learning.created[0].provenance.feedbackEventIds, ["fe_1"]);
  assert.equal(learning.created[0].provenance.runId, "run_1");
});

test("the same refusal holds for an amendment, which is the other way into an existing method", async () => {
  const { distillation, learning } = runs(fakeLearning(["method:learned:do-the-thing"]));
  await distillation.applyCandidate(job, run, {
    candidate: { operation: "amend", origin: "explicit", targetMethodId: "method:learned:do-the-thing" },
    skill: SKILL,
  });
  assert.equal(learning.amended.length, 1);
  assert.equal(learning.amended[0].provenance.origin, "inferred");
});

test("a safety-touching candidate keeps the one flag it is allowed to raise", async () => {
  // `safetyRelated` is never an exemption from outcomes: it keeps a method
  // from being proposed for disuse and nothing else (L-G2), so the run is
  // trusted to raise it.
  const { distillation, learning } = runs();
  await distillation.applyCandidate(job, run, {
    candidate: { operation: "create", risk: { touchesSafety: true } },
    skill: SKILL,
  });
  assert.equal(learning.created[0].provenance.safetyRelated, true);
  assert.equal(learning.created[0].provenance.origin, "inferred");
});

test("no_change writes nothing at all, which is the commonest correct answer", async () => {
  const { distillation, learning, enqueued } = runs();
  const applied = await distillation.applyCandidate(job, run, { candidate: { operation: "no_change" } });
  assert.deepEqual(applied, { operation: "no_change", methodId: undefined });
  assert.equal(learning.created.length, 0);
  assert.equal(enqueued.length, 0);
});

test("an unknown operation and an unparseable skill are both refused before the store sees them", async () => {
  const { distillation, learning } = runs();
  await assert.rejects(
    () => distillation.applyCandidate(job, run, { candidate: { operation: "publish" }, skill: SKILL }),
    (error) => error.code === "method_candidate_invalid" && /publish/.test(error.message),
  );
  await assert.rejects(
    () => distillation.applyCandidate(job, run, { candidate: { operation: "create" }, skill: "no frontmatter here" }),
    (error) => error.code === "method_candidate_invalid",
  );
  await assert.rejects(
    () => distillation.applyCandidate(job, run, { candidate: { operation: "amend" }, skill: SKILL }),
    (error) => error.code === "method_candidate_invalid" && /must name the method/.test(error.message),
  );
  assert.equal(learning.created.length, 0);
  assert.equal(learning.amended.length, 0);
});

test("a written method is integrated and then consolidated at once, not at the next nightly pass", async () => {
  const { distillation, enqueued } = runs();
  await distillation.applyCandidate(job, run, { candidate: { operation: "create" }, skill: SKILL });
  assert.deepEqual(enqueued.map((entry) => [entry.kind, entry.payload.action]), [["consolidate", "integrate"], ["consolidate", "sleep"]]);
  assert.equal(enqueued[0].payload.methodId, "method:learned:do-the-thing");
  assert.equal(enqueued[0].opts.idempotencyKey, "consolidate:integrate:method:learned:do-the-thing:1",
    "keyed on the revision: each change gets its own pass, a retry does not queue a second");
  assert.equal(enqueued[1].opts.idempotencyKey, "consolidate:sleep:after:method:learned:do-the-thing:1");
});

test("a create under a name the library already holds becomes that method's next revision", async () => {
  // 2026-09-21: the id is the name, account-wide, so a second project learning
  // the same method was refused as a revision conflict and the lesson lost.
  const { distillation, learning, enqueued } = runs(fakeLearning(["method:learned:do-the-thing"]));
  const applied = await distillation.applyCandidate(job, run, { candidate: { operation: "create" }, skill: SKILL });
  assert.equal(learning.created.length, 0);
  assert.equal(learning.amended.length, 1);
  assert.equal(learning.amended[0].methodId, "method:learned:do-the-thing");
  assert.equal(learning.amended[0].expectedRevision, 3);
  assert.deepEqual(applied, { operation: "amend", methodId: "method:learned:do-the-thing" });
  assert.equal(enqueued[0].opts.idempotencyKey, "consolidate:integrate:method:learned:do-the-thing:4");
});

test("a delivered package is read as one method, not as a method whose scripts are its own files", async () => {
  // 2026-09-21: the first two lessons production ever finished were refused as
  // `method_invalid` — `applyCandidate` handed the store the whole delivered
  // package as the method's attached scripts, and none of it lives under
  // `scripts/` or `tests/`. Every test above passes a hand-built output; this
  // one goes through the decoder the runtime reader uses.
  const { distillation, learning } = runs();
  const output = decodeLearningOutput({
    "SKILL.md": SKILL,
    "method-candidate.json": JSON.stringify({ schemaVersion: 1, operation: "create" }),
    "distillation-notes.md": "What the run noticed.",
  });
  await distillation.applyCandidate(job, run, output);
  assert.equal(learning.created.length, 1);
  assert.equal(learning.created[0].files, undefined, "the package files are not attachments");
  const parsed = parseSkillFrontmatter(SKILL);
  const verdict = validateMethodSkill({
    frontmatter: learning.created[0].frontmatter,
    body: learning.created[0].body,
    files: learning.created[0].files,
    directoryName: parsed.frontmatter.name,
    requireProvenance: true,
  });
  assert.deepEqual(verdict.issues, [], "what reaches the store passes the store's own rules");
});

test("scripts the proposal itself attaches still travel with it", async () => {
  const { distillation, learning } = runs();
  const files = { "scripts/count.py": "print(1)\n" };
  await distillation.applyCandidate(job, run, decodeLearningOutput({
    "SKILL.md": SKILL,
    "method-candidate.json": JSON.stringify({ schemaVersion: 1, operation: "create", files }),
  }));
  assert.deepEqual(learning.created[0].files, files);
});

test("the researcher's line a candidate carries travels to the store beside the method, never inside it", async () => {
  const { distillation, learning } = runs();
  const display = { title: "先报 GRADE 再报效应量", summary: "Meta 分析的结论先给证据等级，再给效应量和区间。" };
  await distillation.applyCandidate(job, run, decodeLearningOutput({
    "SKILL.md": SKILL,
    "method-candidate.json": JSON.stringify({ schemaVersion: 1, operation: "create", display }),
  }));
  assert.deepEqual(learning.created[0].display, display);
  assert.doesNotMatch(learning.created[0].body, /GRADE 再报/, "the line is not part of SKILL.md");
});

/* ------------------------------------------------ audit 2026-09-26: L-G1, L-G3, M-5 */

test("a learnt method records where it was learnt and from which capability, and its passes run in the learning project", async () => {
  const { distillation, learning, enqueued } = runs();
  await distillation.applyCandidate({ userId: "u1", projectId: "paper", payload: { trigger: "delivered" } },
    { id: "run_1", effectiveAgentId: "meta-analysis" },
    { candidate: { operation: "create", display: { title: "先报等级", summary: "先报证据等级再报效应量。", steps: "1. 先报等级\n2. 再报效应量" } }, skill: SKILL });
  const written = learning.created[0];
  assert.equal(written.projectId, "paper", "the source project, which the store records as provenance");
  assert.equal(written.provenance.sourceProjectId, "paper");
  assert.equal(written.provenance.capabilityId, "meta-analysis", "the family a later launch filters by (L-G7)");
  assert.equal(written.provenance.trigger, "delivered");
  assert.equal(written.provenance.signal, "run");
  assert.equal(written.steps, "1. 先报等级\n2. 再报效应量", "the steps travel beside the method (M-5)");
  assert.ok(enqueued.every((entry) => entry.opts.projectId === LEARNING_PROJECT_ID),
    "filed under the lesson's project, a pass went with it when that project was deleted (L-G1)");

  // A lesson that moved to the learning project when its project was deleted
  // still names the project it came from.
  const moved = runs();
  await moved.distillation.applyCandidate({ userId: "u1", projectId: LEARNING_PROJECT_ID, payload: { trigger: "delivered", sourceProjectId: "gone" } },
    { id: "run_2" }, { candidate: { operation: "create" }, skill: SKILL });
  assert.equal(moved.learning.created[0].provenance.sourceProjectId, "gone");
  const orphan = runs();
  await orphan.distillation.applyCandidate({ userId: "u1", projectId: LEARNING_PROJECT_ID, payload: { trigger: "delivered" } },
    { id: "run_3" }, { candidate: { operation: "create" }, skill: SKILL });
  assert.equal(orphan.learning.created[0].provenance.sourceProjectId, undefined, "the learning project is never a source");
});

test("a lesson taught only by the platform's reviewer is kept for the handbook and never touches the researcher's library", async () => {
  // Both methods production learnt in September: `repair_accepted` against
  // the reviewer's own findings, filed as 「我的做法」 (L-G3).
  const reviewerJob = { userId: "u1", projectId: "meta", payload: { trigger: "repair_accepted", repairRounds: { content: 0, structural: 0 }, inRunAttempts: 2 } };
  const created = runs();
  const applied = await created.distillation.applyCandidate(reviewerJob, { id: "run_1", effectiveAgentId: "meta-analysis" },
    { candidate: { operation: "create" }, skill: SKILL });
  assert.deepEqual(applied, { operation: "handbook", methodId: "method:handbook:do-the-thing" });
  assert.equal(created.learning.created.length, 0);
  assert.equal(created.learning.handbook.length, 1);
  assert.equal(created.learning.handbook[0].capabilityId, "meta-analysis");
  assert.equal(created.learning.handbook[0].provenance.signal, "reviewer");
  assert.equal(created.enqueued.length, 0, "nothing of the researcher's library to consolidate");

  // Even an amendment of a method the researcher holds: the reviewer's lesson
  // does not rewrite their method.
  const amending = runs(fakeLearning(["method:learned:do-the-thing"]));
  await amending.distillation.applyCandidate(reviewerJob, { id: "run_1" },
    { candidate: { operation: "amend", targetMethodId: "method:learned:do-the-thing" }, skill: SKILL });
  assert.equal(amending.learning.amended.length, 0);
  assert.equal(amending.learning.handbook.length, 1);

  // The same trigger with the researcher's own edit or correction is theirs.
  for (const payload of [{ ...reviewerJob.payload, feedback: [{ id: "fe_1" }] }, { ...reviewerJob.payload, steeredCorrections: 1 }]) {
    const theirs = runs();
    await theirs.distillation.applyCandidate({ ...reviewerJob, payload }, { id: "run_1" }, { candidate: { operation: "create" }, skill: SKILL });
    assert.equal(theirs.learning.created.length, 1);
    assert.equal(theirs.learning.created[0].provenance.signal, "researcher");
  }
  // And the signal a run's own input carried decides when it is given.
  const told = runs();
  await told.distillation.applyCandidate(reviewerJob, { id: "run_1" }, { candidate: { operation: "create" }, skill: SKILL }, { signal: "researcher" });
  assert.equal(told.learning.created.length, 1);
});

test("the researcher's own corrections and edits open the input, before the transcript and the reviewer's findings", () => {
  const transcript = {
    header: { completeness: "complete" },
    messages: [
      { sessionId: "root", seq: 1, role: "user", parts: [{ type: "text", text: "<evimed-brief>请做一个 Meta 分析</evimed-brief>" }] },
      { sessionId: "root", seq: 2, role: "assistant", parts: [{ type: "text", text: "好的。" }] },
      { sessionId: "root", seq: 3, role: "user", parts: [{ type: "text", text: "<evimed-correction>先报 GRADE 等级，再报效应量</evimed-correction>" }] },
      { sessionId: "root", seq: 4, role: "user", parts: [{ type: "text", text: "<evimed-correction>我的手机号 13800138000，发我</evimed-correction>" }] },
    ],
  };
  const input = buildDistillationInput({
    run: { id: "run_1", effectiveAgentId: "meta-analysis" }, trigger: "repair_accepted", transcript,
    repairIssues: [{ round: 1, code: "claim_quote_missing", message: "…" }],
    correctionRecords: [{ recordId: "mem_1", key: "reporting.order", text: "先写结论再写证据" }],
  });
  const keys = Object.keys(input);
  assert.ok(keys.indexOf("corrections") < keys.indexOf("transcriptExcerpts"));
  assert.ok(keys.indexOf("feedback") < keys.indexOf("transcriptExcerpts"));
  assert.ok(keys.indexOf("transcriptExcerpts") < keys.indexOf("repairIssues"), "the reviewer's findings come after the researcher");
  assert.deepEqual(input.corrections, [
    { source: "steered", sessionId: "root", seq: 3, text: "先报 GRADE 等级，再报效应量" },
    { source: "memory", recordId: "mem_1", key: "reporting.order", text: "先写结论再写证据" },
  ], "their own words, unwrapped; a message carrying a patient's phone number is dropped whole");
  assert.equal(input.correctionsDropped.sensitive, 1);
  assert.equal(input.signal, "researcher");
  assert.equal(buildDistillationInput({ run: { id: "r" }, trigger: "repair_accepted", transcript: null }).signal, "reviewer");
  assert.equal(buildDistillationInput({ run: { id: "r" }, trigger: "delivered", transcript: null }).signal, "run");
  assert.equal(lessonSignal({ trigger: "repair_accepted", feedback: [{ id: "fe" }] }), "researcher");
});

test("a distillation reads the correction memories its lesson names and hands them to the run first", async () => {
  /** @type {any[]} */
  const dispatched = [];
  /** @type {any[]} */
  const asked = [];
  const distillation = new MethodDistillationRuns({
    learning: { ...fakeLearning(), async listMethods() { return { items: [] }; } },
    dispatch: async (request) => { dispatched.push(request); return { runId: "lr_1", sessionId: "ls_1", dispatchId: request.dispatchId }; },
    readResult: async () => ({ status: "running" }),
    readCorrections: async (userId, ids) => { asked.push({ userId, ids }); return [{ recordId: "mem_1", key: "k", text: "不要用固定剂量" }]; },
  });
  const project = { id: "paper", rootDir: "/nonexistent", metaDir: "/nonexistent/.openscience" };
  const result = await distillation.execute({ job: { userId: "u1", projectId: "paper", payload: { trigger: "correction", corrections: [{ recordId: "mem_1", key: "k" }] } },
    project, run: { id: "run_1" } });
  assert.equal(result.state, "pending");
  assert.deepEqual(asked, [{ userId: "u1", ids: ["mem_1"] }]);
  assert.deepEqual(dispatched[0].input.corrections, [{ source: "memory", recordId: "mem_1", key: "k", text: "不要用固定剂量" }]);
  assert.equal(dispatched[0].input.signal, "researcher");
});

/** A project directory with a stored transcript per run, as `persistRunTranscript` leaves them.
 *  @param {string} root @param {string} id @param {string[]} runIds */
async function projectWithTranscripts(root, id, runIds, userId = "u1") {
  const rootDir = path.join(root, id);
  const project = { id, userId, rootDir, metaDir: path.join(rootDir, ".openscience"), workspaceDir: path.join(rootDir, "workspace") };
  await mkdir(path.join(project.metaDir, TRANSCRIPT_DIR_NAME), { recursive: true });
  for (const runId of runIds) {
    const header = { schemaVersion: 1, runId, capturedAt: "2026-09-28T00:00:00.000Z", completeness: "complete", sessions: [], missing: [] };
    const message = { sessionId: `s_${runId}`, seq: 1, role: "user", source: "user", parts: [{ type: "text", text: `${id} 的第 ${runId} 次综述` }] };
    await writeFile(transcriptPath(project, runId), `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`);
  }
  return project;
}

test("a routine's peer is read from whichever of the researcher's projects it ran in, and from nowhere else", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "evimed-routine-peers-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const renal = await projectWithTranscripts(root, "renal", ["run_c", "run_b"]);
  const aspirin = await projectWithTranscripts(root, "aspirin", ["run_a"]);
  const theirs = await projectWithTranscripts(root, "theirs", ["run_x"], "u2");
  /** @type {any[]} */
  const dispatched = [];
  /** @type {string[]} */
  const resolved = [];
  const distillation = new MethodDistillationRuns({
    learning: { ...fakeLearning(), async listMethods() { return { items: [] }; } },
    dispatch: async (request) => { dispatched.push(request); return { runId: "lr_1", sessionId: "ls_1", dispatchId: request.dispatchId }; },
    readResult: async () => ({ status: "running" }),
    resolveProject: async (userId, projectId) => {
      resolved.push(`${userId}/${projectId}`);
      if (projectId === "aspirin") return aspirin;
      if (projectId === "theirs") return theirs; // a resolver that answered for the wrong account
      throw Object.assign(new Error("Project not found."), { code: "project_not_found", status: 404 });
    },
  });
  const read = (/** @type {any} */ input) => input.peerRuns.map((/** @type {any} */ peer) => [peer.runId, peer.transcriptCompleteness, peer.transcriptExcerpts[0]?.parts[0]?.text ?? null]);

  await distillation.execute({ project: renal, run: { id: "run_c", effectiveAgentId: "clinical-evidence-synthesis" }, job: {
    userId: "u1", projectId: "renal",
    payload: { runId: "run_c", trigger: "routine", peers: [
      { runId: "run_a", projectId: "aspirin" },
      { runId: "run_b", projectId: "renal" },
      { runId: "run_x", projectId: "theirs" },
      { runId: "run_gone", projectId: "deleted-since" },
    ] },
  } });
  assert.deepEqual(read(dispatched[0].input), [
    ["run_a", "complete", "aspirin 的第 run_a 次综述"],
    ["run_b", "complete", "renal 的第 run_b 次综述"],
    ["run_x", "unavailable", null],
    ["run_gone", "unavailable", null],
  ], "another project of the same researcher is read; one resolved for anyone else, or gone, is unavailable");
  assert.deepEqual(resolved, ["u1/aspirin", "u1/theirs", "u1/deleted-since"], "resolved only within the lesson's account, never for its own project");

  // An internal project is never resolved, whatever the payload says.
  resolved.length = 0;
  await distillation.execute({ project: renal, run: { id: "run_c" }, job: {
    userId: "u1", projectId: "renal", payload: { runId: "run_c", trigger: "routine", peers: [{ runId: "run_a", projectId: LEARNING_PROJECT_ID }] },
  } });
  assert.deepEqual(read(dispatched[1].input), [["run_a", "unavailable", null]]);
  assert.deepEqual(resolved, []);

  // A lesson queued before 2026-09-28 names run ids only, all in its own project.
  await distillation.execute({ project: renal, run: { id: "run_c" }, job: {
    userId: "u1", projectId: "renal", payload: { runId: "run_c", trigger: "routine", peerRunIds: ["run_b", "run_c"] },
  } });
  assert.deepEqual(read(dispatched[2].input), [["run_b", "complete", "renal 的第 run_b 次综述"]], "the run itself is never its own peer");

  // A lesson moved when its project was deleted reads that project's peers
  // from the copies beside it in the learning project.
  const learning = await projectWithTranscripts(root, LEARNING_PROJECT_ID, ["run_c", "run_b"]);
  await distillation.execute({ project: learning, run: { id: "run_c" }, job: {
    userId: "u1", projectId: LEARNING_PROJECT_ID,
    payload: { runId: "run_c", trigger: "routine", sourceProjectId: "renal", peers: [{ runId: "run_b", projectId: "renal" }, { runId: "run_a", projectId: "aspirin" }] },
  } });
  assert.deepEqual(read(dispatched[3].input), [
    ["run_b", "complete", `${LEARNING_PROJECT_ID} 的第 run_b 次综述`],
    ["run_a", "complete", "aspirin 的第 run_a 次综述"],
  ]);
});

test("a message typed into the running turn is the researcher's correction; nothing else in the session is", () => {
  const typed = (/** @type {number} */ seq, /** @type {number} */ turnStartSeq, /** @type {string} */ text, extra = {}) =>
    ({ sessionId: "root", seq, turnStartSeq, role: "user", source: "user", sourceRequestId: `req_${seq}`, parts: [{ type: "text", text }], ...extra });
  const transcript = {
    header: { completeness: "complete" },
    messages: [
      // An earlier run's turn in the same conversation, with its own steer.
      typed(0, 0, "上一个问题"),
      typed(2, 0, "上一个问题的插话"),
      // This run's turn: its question, the model's work, then what was typed into it.
      typed(10, 10, "请综述二甲双胍的肾功能剂量"),
      { sessionId: "root", seq: 11, turnStartSeq: 10, role: "assistant", source: "system", parts: [{ type: "text", text: "开始检索。" }] },
      typed(12, 10, "只纳入随机对照试验", { sourceRequestId: "frame_steer" }),
      typed(13, 10, "<evimed-repair>run_1</evimed-repair> 修复这一处", { sourceRequestId: null }),
      { sessionId: "root", seq: 14, turnStartSeq: 10, role: "user", source: "plugin", parts: [{ type: "text", text: "注入的上下文" }] },
      typed(15, 10, "<evimed-correction>2020 年以后</evimed-correction>", { sourceRequestId: "route_steer" }),
      // A delegate's session is not where the researcher types.
      { sessionId: "child", seq: 3, turnStartSeq: 1, role: "user", source: "user", parts: [{ type: "text", text: "子任务的第二条" }] },
      // The next turn — a queued follow-up is its own turn, and its own run.
      typed(20, 20, "下一个问题"),
    ],
  };
  const run = { id: "run_1", sessionId: "root", kernelRequestIds: ["req_10"] };
  assert.deepEqual(steeredCorrections(transcript, run).corrections.map((entry) => [entry.seq, entry.text]), [
    [12, "只纳入随机对照试验"],
    [15, "2020 年以后"],
  ]);
  // An adopted native run names its turn instead of a request id.
  assert.deepEqual(steeredCorrections(transcript, { id: "run_0", sessionId: "root", nativeTurn: { startSeq: 0, userSeq: 0 } })
    .corrections.map((entry) => entry.seq), [2]);
  // And the input says whose evidence the lesson rests on.
  const input = buildDistillationInput({ run: { ...run, effectiveAgentId: "clinical-evidence-synthesis" }, trigger: "correction", transcript });
  assert.equal(input.signal, "researcher");
  assert.deepEqual(input.corrections.map((entry) => entry.source), ["steered", "steered"]);
});
